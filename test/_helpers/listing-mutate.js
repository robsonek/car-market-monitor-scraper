// Helpers that take a real listing fixture HTML and produce in-memory variants
// (duplicate edges, empty page, fewer edges) without committing extra HTML
// files. The tests pass these strings to a stubbed fetch.

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>(.*?)<\/script>/s;

function parseListingNextData(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) throw new Error("__NEXT_DATA__ not found in listing fixture");
  return JSON.parse(m[1]);
}

function rewriteListingNextData(html, mutate) {
  const data = parseListingNextData(html);
  const urqlState = data.props.pageProps.urqlState;
  for (const [, state] of Object.entries(urqlState)) {
    let payload;
    try {
      payload = JSON.parse(state.data || "{}");
    } catch {
      continue;
    }
    if (!payload?.advertSearch) continue;
    mutate(payload.advertSearch);
    state.data = JSON.stringify(payload);
  }
  const json = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  return html.replace(NEXT_DATA_RE, () => `<script id="__NEXT_DATA__" type="application/json">${json}</script>`);
}

// Returns the HTML with edges sliced to [start, end). Useful for shrinking the
// 32-card baseline down to e.g. 4 cards so the test focuses on a single page
// without paginating through 32 stubbed fetches.
export function withSlicedEdges(html, end) {
  return rewriteListingNextData(html, (search) => {
    search.edges = (search.edges || []).slice(0, end);
  });
}

// Returns the HTML with the first edge appended again at the end of the array,
// so the parser sees the same ad_id twice. Used to verify dedup.
export function withDuplicateFirstEdge(html) {
  return rewriteListingNextData(html, (search) => {
    if (!search.edges?.length) return;
    search.edges = [...search.edges, JSON.parse(JSON.stringify(search.edges[0]))];
  });
}

// Returns the HTML with all edges removed. Used to simulate "page out of range"
// — the parser returns 0 cards and stops paginating.
export function withEmptyEdges(html) {
  return rewriteListingNextData(html, (search) => {
    search.edges = [];
  });
}

// Override totalCount/pageSize. Used to drive multi-page pagination tests
// without actually needing 87 cards in the fixture.
export function withPagination(html, { totalCount, pageSize }) {
  return rewriteListingNextData(html, (search) => {
    search.totalCount = totalCount;
    search.pageInfo = { __typename: "Pager", pageSize, currentOffset: 0 };
  });
}

// Retag the first edge's id and url. Tests for the runSource flow need
// `card.ad_id` (from listing) to equal `detail.external_id` (from the detail
// fixture's advert.id) so applyDetail's byExternalId map matches across the
// listing → detail join. The fixture builder synthesizes different IDs for
// the two fixtures, so we patch the listing in-memory to use the detail's id.
export function withFirstEdge(html, { id, url }) {
  return rewriteListingNextData(html, (search) => {
    if (!search.edges?.length) return;
    if (id != null) search.edges[0].node.id = id;
    if (url != null) search.edges[0].node.url = url;
  });
}

// Removes advertSearch from every urqlState payload while leaving __NEXT_DATA__
// structurally valid. This simulates the observed upstream variant where the
// page returns 200 + Next.js bootstrap data, but the listing GraphQL cache is
// missing (e.g. bot-challenge/throttled skeleton).
export function withoutAdvertSearch(html) {
  const data = parseListingNextData(html);
  const urqlState = data.props.pageProps.urqlState;
  for (const [, state] of Object.entries(urqlState)) {
    let payload;
    try {
      payload = JSON.parse(state.data || "{}");
    } catch {
      continue;
    }
    if (!payload?.advertSearch) continue;
    delete payload.advertSearch;
    state.data = JSON.stringify(payload);
  }
  const json = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  return html.replace(NEXT_DATA_RE, () => `<script id="__NEXT_DATA__" type="application/json">${json}</script>`);
}
