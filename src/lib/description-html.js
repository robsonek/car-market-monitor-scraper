import { decodeHtmlEntities } from "./utils.js";

// Normalizacja i sanitizacja HTML opisu sprzedawcy. Uruchamiana raz, przy
// ingest'cie. Efekt trafia do payload_json.description_html jako JEDYNA forma
// opisu w bazie — plain text dla diffów/searcha jest derywowany w locie przez
// stripHtml z utils.js.
//
// Dwa zadania:
//
//   1. Stabilizacja — upstream wstrzykuje `phoneNumber="<rotujący-ciphertext>"`
//      w inline spanach, różny na każdym scrape'ie. Podmieniamy te węzły na
//      statyczny `<a data-kind="phone" href="tel:...">NUMER</a>` używając już
//      odszyfrowanych numerów, dzięki czemu znormalizowany HTML jest
//      byte-identyczny między scrape'ami (i hash/diff nie fluktuuje).
//
//   2. Sanitizacja — drop dangerous tagów (script/style/iframe), unwrap
//      nieznanych tagów (zachowaj tekst), whitelist atrybutów. To nie tyle
//      XSS protection (frontend ma swój sanitizer jako druga linia obrony),
//      ile "czyszczenie balastu" — atrybuty typu `class="cms-paragraph-1"`
//      z otomoto są bezużyteczne i tylko puchną payload.

const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul",
]);

// Te tagi + ich zawartość lecą do śmieci. "raw text" elementy HTML5 muszą tu
// siedzieć razem (script/style/template), bo ich zawartość NIE jest
// normalnym HTML-em i nie chcemy jej unwrapować.
const DROP_TAGS_WITH_CONTENT = new Set([
  "script", "style", "template", "iframe", "object", "noscript", "svg", "math",
]);

// Atrybut noszący token telefonu na inline spanach otomoto. Zrobione
// case-insensitive bo widzieliśmy obie wersje `phoneNumber` i `phonenumber`.
const PHONE_ATTR = "phonenumber";

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link"]);

// ---- tokenizer ----

// Lekki parser HTML: linowy walk z regexem dla tagów i węzłów tekstowych.
// Nie obsługuje CDATA, nie obsługuje DOCTYPE (otomoto ich nie wstawia w polu
// description), ignoruje komentarze. Wystarczy — opis to prosty fragment, nie
// cały dokument. Dla raw-text elementów (script/style) przeskakujemy do
// odpowiadającego `</tag>`, żeby nie interpretować treści jako markupa.
function tokenize(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", text: html.slice(i) });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: "text", text: html.slice(i, lt) });
    }

    // Comment <!-- ... -->
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // DOCTYPE / processing instructions — skip to next '>'
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 1);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      tokens.push({ kind: "text", text: html.slice(lt) });
      break;
    }

    let body = html.slice(lt + 1, gt);
    const isClose = body.startsWith("/");
    if (isClose) body = body.slice(1);
    const selfClosingSlash = body.endsWith("/");
    if (selfClosingSlash) body = body.slice(0, -1);

    const nameMatch = body.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*([\s\S]*)$/);
    if (!nameMatch) {
      // Malformed — skip over it.
      i = gt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const attrs = isClose ? {} : parseAttrs(nameMatch[2]);

    if (isClose) {
      tokens.push({ kind: "close", name });
      i = gt + 1;
      continue;
    }

    const selfClosing = selfClosingSlash || VOID_TAGS.has(name);
    tokens.push({ kind: selfClosing ? "self" : "open", name, attrs });
    i = gt + 1;

    // For raw-text drop tags, fast-forward past the matching close tag so we
    // don't accidentally lex their body as markup. Close-tag match is
    // case-insensitive.
    if (!selfClosing && DROP_TAGS_WITH_CONTENT.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(i);
      const m = rest.match(closeRe);
      if (!m) {
        i = len;
      } else {
        i += m.index + m[0].length;
      }
      // Push a synthetic close so the stack stays balanced in the sanitizer.
      tokens.push({ kind: "close", name });
    }
  }
  return tokens;
}

// Bardzo prosty parser atrybutów: `name="value"`, `name='value'`, `name=value`
// albo goły `name`. Nie rozwiązuje encji — robi to dopiero decodeHtmlEntities
// w momencie emisji wartości text'owej lub href.
function parseAttrs(str) {
  const out = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out[name] = value;
  }
  return out;
}

// ---- emitter ----

function escapeText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function sanitizeHref(raw) {
  if (!raw) return null;
  const trimmed = decodeHtmlEntities(raw).trim();
  if (!/^(https?:|mailto:|tel:)/i.test(trimmed)) return null;
  return trimmed;
}

// ---- main entry point ----

export function normalizeDescriptionHtml(rawHtml, phoneMap) {
  if (!rawHtml || typeof rawHtml !== "string") return null;
  const tokens = tokenize(rawHtml);

  // Stack trzyma "emitted" flagę dla każdego otwarcia: jeśli sanitizer
  // zdecydował zemitować `<p>`, to odpowiadający `</p>` też ma zostać
  // zemitowany. Dla tagów unwrapped (nieznane) flag = false — close zostanie
  // zignorowany. Dla tagów phone-span (cały blok zastępowany jednym `<a>`)
  // używamy specjalnego markera "phone-skip" — close tego samego tagu ma
  // odsłonić dalsze emitowanie i NIC nie wypisać sam z siebie.
  const stack = [];
  let out = "";
  // Gdy jesteśmy wewnątrz "phone-skip" bloku, wstrzymujemy wszystkie teksty
  // i otwarcia — czekamy tylko na matching close. Liczymy zagnieżdżenia tego
  // samego tagu, żeby wewnętrzne `<span>` nie zerwały nam trackingu.
  let phoneSkipDepth = 0;
  let phoneSkipTag = null;

  const resolvePhone = (token) => {
    if (!phoneMap) return null;
    if (phoneMap instanceof Map) return phoneMap.get(token) || null;
    return phoneMap[token] || null;
  };

  for (const tok of tokens) {
    // Inside a phone-replaced block we only care about counting nested
    // opens/closes of the same tag so we know when to emerge.
    if (phoneSkipDepth > 0) {
      if (tok.kind === "open" && tok.name === phoneSkipTag) {
        phoneSkipDepth += 1;
      } else if (tok.kind === "close" && tok.name === phoneSkipTag) {
        phoneSkipDepth -= 1;
        if (phoneSkipDepth === 0) {
          phoneSkipTag = null;
        }
      }
      continue;
    }

    if (tok.kind === "text") {
      out += escapeText(decodeHtmlEntities(tok.text));
      continue;
    }

    if (tok.kind === "open" || tok.kind === "self") {
      const attrs = tok.attrs || {};
      // Phone-span replacement: any tag carrying phoneNumber="..." is
      // swallowed (along with its content for non-self-closing form) and
      // substituted with the resolved number. We don't care what the tag
      // name is — spans, divs, whatever.
      if (Object.hasOwn(attrs, PHONE_ATTR)) {
        const token = attrs[PHONE_ATTR];
        const resolved = resolvePhone(token);
        if (resolved) {
          const tel = String(resolved).replace(/\s+/g, "");
          out += `<a data-kind="phone" href="tel:${escapeAttr(tel)}">${escapeText(resolved)}</a>`;
        }
        // Jeśli nie dało się rozwiązać — pomiń cały blok po cichu. Nie
        // chcemy zapisywać surowego ciphertextu (rotuje między scrape'ami)
        // ani pustego węzła.
        if (tok.kind === "open") {
          phoneSkipTag = tok.name;
          phoneSkipDepth = 1;
        }
        continue;
      }

      if (DROP_TAGS_WITH_CONTENT.has(tok.name)) {
        // Tokenizer już zwinął zawartość za nas — tu tylko ignorujemy
        // syntetyczny open (i odpowiadający close przyjdzie za chwilę,
        // z tego samego powodu nie wypiszemy nic).
        if (tok.kind === "open") stack.push({ name: tok.name, emitted: false });
        continue;
      }

      if (!ALLOWED_TAGS.has(tok.name)) {
        // Unwrap: nie emituj otwarcia, ale kontynuuj przetwarzanie dzieci.
        if (tok.kind === "open") stack.push({ name: tok.name, emitted: false });
        continue;
      }

      // Emit allowed tag. Whitelist atrybutów minimalna — tylko href dla <a>.
      let tagStr = `<${tok.name}`;
      if (tok.name === "a") {
        const safeHref = sanitizeHref(attrs.href);
        if (safeHref) {
          tagStr += ` href="${escapeAttr(safeHref)}"`;
          if (/^https?:/i.test(safeHref)) {
            tagStr += ` rel="noopener noreferrer" target="_blank"`;
          }
        }
      }
      if (tok.kind === "self" || VOID_TAGS.has(tok.name)) {
        out += `${tagStr}>`;
        continue;
      }
      out += `${tagStr}>`;
      stack.push({ name: tok.name, emitted: true });
      continue;
    }

    if (tok.kind === "close") {
      // Znajdź najbliższe pasujące otwarcie na stacku. Jeśli go nie ma
      // (close sierota), po prostu ignoruj. Jeśli jest — pop wszystkiego
      // do niego włącznie, emitując close'y tylko dla tych wpisów które
      // faktycznie były wyemitowane.
      const idx = findMatchingOpen(stack, tok.name);
      if (idx === -1) continue;
      for (let j = stack.length - 1; j > idx; j--) {
        const entry = stack[j];
        if (entry.emitted) out += `</${entry.name}>`;
      }
      const matched = stack[idx];
      if (matched.emitted) out += `</${matched.name}>`;
      stack.length = idx;
      continue;
    }
  }

  // Close any tags still open at EOF.
  for (let j = stack.length - 1; j >= 0; j--) {
    if (stack[j].emitted) out += `</${stack[j].name}>`;
  }

  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findMatchingOpen(stack, name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].name === name) return i;
  }
  return -1;
}
