# Car Market Monitor (GitHub Actions edition)

Monitor zapisanych wyszukiwarek ofert samochodów (źródło: otomoto). Co godzinę GitHub Actions pobiera wszystkie strony listingu, ściąga detale ofert, zapisuje pełne snapshoty do SQLite i wykrywa zmiany pól między kolejnymi przebiegami.

To repo zawiera **scraper + pipeline danych**. Przeglądarka danych (dashboard) żyje w osobnym, prywatnym repo i jest hostowana na Cloudflare Pages za logowaniem - patrz [Dashboard](#dashboard).

## Gdzie jest baza

Baza to pojedynczy plik SQLite `db/car-market-monitor.sqlite` - **nie jest commitowana do repo** (jest w `.gitignore`). Trzymamy ją jako **GitHub Release**:

- `latest-data` - zawsze najnowsza baza (workflow pobiera ją na starcie i odsyła po runie) plus jej kopia skompresowana brotli `car-market-monitor.sqlite.br` dla dashboardu,
- `data/<YYYY-MM-DD>` - dzienne snapshoty (trzymane 30 dni).

Runner Actions jest efemeryczny, więc Release jest jedynym trwałym magazynem między runami.

## Architektura

- **Cron GitHub Actions** (`0 * * * *`, co godzinę) odpala workflow `scrape`.
- Workflow: pobiera bazę z release `latest-data` → `node bin/run.js` → prune starych payloadów → kompresja brotli (`bin/compress-db.js`) → odsyła bazę, jej wersję `.br` i na końcu manifest do release.
- Jeden proces Node 24; źródła i detale pobierane **sekwencyjnie** (`p-limit(1)`), żeby nie złapać bana.
- Cała faza zapisu (snapshoty + diffy + reconcile + wiersz runu) leci w jednej transakcji `better-sqlite3` per źródło - crash = rollback, brak pół-finalizowanego stanu.

### Guardy pipeline'u

- **Completeness guard (reconcile)**: jeśli z aktywnego inwentarza „znika" w jednym runie podejrzanie duża część (soft-block / obcięta paginacja), reconcile jest pomijany (run → `PARTIAL_SUCCESS`), żeby nie oznaczyć całej bazy jako MISSING.
- **Upload guard**: workflow nie nadpisze `latest-data`, jeśli zbudowana baza ma mniej runów niż pobrana (oznaka nieudanego pobrania) - chroni dobrą bazę przed nadpisaniem pustką.

## Pipeline (per źródło)

1. **Discovery** - wszystkie strony listingu, dedup po `external_id`. Pinujemy `search[order]=created_at:desc` dla deterministycznej paginacji (default ordering miesza promoted ads i kradnie sloty unikalnym ofertom).
2. **Detail fetch** - osobny request per oferta, retry z backoffem.
3. **Normalize** - odpowiedź detalu → stabilny payload + typowane kolumny.
4. **Apply** (jedna transakcja): insert/update listing, nowy snapshot gdy zmienił się hash field_mapa, diff pól do `listing_changes`, reconcile z hysteresis, wiersz `scrape_runs`.

`PARTIAL_SUCCESS` = część detali padła albo guard pominął reconcile. `FAILED` = wszystkie detale padły lub discovery padło na starcie.

## Co zapisujemy

- historię runów (`scrape_runs`),
- bieżący stan oferty (`listings`) - ~150 parametrów z `parametersDict` jako typowane kolumny + pola identyfikacyjne (łącznie 188 kolumn),
- pełne snapshoty (`listing_snapshots.payload_json`),
- diff pól (`listing_changes`),
- zniknięcia/powroty ofert (po hysteresis, `MISSING_THRESHOLD=2`).

## Struktura

- [bin/run.js](bin/run.js) - CLI scrape'a (uruchamiany przez workflow).
- [bin/sources.js](bin/sources.js) - zarządzanie źródłami.
- [bin/prune-snapshot-payloads.js](bin/prune-snapshot-payloads.js) - czyszczenie/archiwizacja starych payloadów (workflow woła `--no-archive`).
- [bin/compress-db.js](bin/compress-db.js) - kompresja bazy brotli do `<db>.br` dla dashboardu (uruchamiać po zamknięciu bazy, czyli po prune).
- [src/lib/db.js](src/lib/db.js) - otwarcie SQLite + automatyczne migracje (fail-fast guard + fingerprint schematu).
- [src/lib/marketplace-source.js](src/lib/marketplace-source.js) - parser listingu/detalu, `normalizeDetail()`, dekryptaż tokenów.
- [src/lib/marketplace-source-params.js](src/lib/marketplace-source-params.js) - definicja parametrów + `extractParams()`. **MUSI być w sync z DDL `listings`**.
- [src/lib/scrape.js](src/lib/scrape.js) - orkiestracja runów, snapshoty, diffy, reconcile + completeness guard, hash filtering noisy fields.
- [migrations/0001_init.sql](migrations/0001_init.sql) - schemat. Model migracji: „wyczyść bazę i puść od nowa", nie inkrementalne ALTER-y (jeden plik, `user_version=1`).
- [.github/workflows/scrape.yml](.github/workflows/scrape.yml) - cron + scrape + release.
- [.github/workflows/test.yml](.github/workflows/test.yml) - testy na push/PR.

## Setup lokalny

```bash
npm install        # Node 24 (patrz .node-version)
```

Baza powstanie sama przy pierwszym uruchomieniu (migracje aplikowane automatycznie). Lokalnie pracujesz na własnej kopii; produkcyjna baza żyje w release `latest-data`.

> `better-sqlite3` to moduł natywny. Od wersji 13 korzysta z N-API, więc prebuilt binary działa na różnych wersjach Node i po zmianie Node nie trzeba już `npm rebuild`. Projekt celuje w **Node 24** (`.node-version`, `engines`).

## Zarządzanie źródłami

```bash
npm run sources -- add --url '<SOURCE_URL>' --name 'Porsche Taycan'
npm run sources -- list
npm run sources -- disable --id <SOURCE_ID>
npm run sources -- enable  --id <SOURCE_ID>
npm run sources -- remove  --id <SOURCE_ID>
```

## Ręczne uruchomienie scrape

```bash
npm run scrape                    # wszystkie aktywne źródła
npm run scrape -- --source <ID>   # jedno źródło
```

Exit code: `0` ok (nawet przy `PARTIAL_SUCCESS`), `2` wszystkie źródła `FAILED`, `1` hard crash.

## Testy

```bash
npm test
```

## Dashboard

Frontend (przeglądarka danych) **nie jest w tym repo**. Żyje w osobnym, **prywatnym** repo `car-market-monitor-web` i jest hostowany na **Cloudflare Pages za logowaniem**. Stronę zasila baza z publicznego release `latest-data` - Cloudflare Function pobiera ją serwerowo i podaje zalogowanym użytkownikom (sam plik bazy w release pozostaje publiczny). Proxy serwuje wersję `.br` z `Content-Encoding: br`, więc przeglądarka pobiera ok. 7 razy mniej danych i rozpakowuje je sama; gdy `.br` brak, wraca do surowej bazy.

## Ważne uwagi

- Cron GitHub Actions bywa opóźniony o kilka minut względem pełnej godziny - to normalne.
- Parser zależy od struktury `__NEXT_DATA__` źródła; zmiana po stronie otomoto objawi się runami `FAILED`.
- Baza rośnie wraz ze snapshotami; `prune-snapshot-payloads.js` trzyma rozmiar w ryzach (stub starych payloadów spoza bieżącego snapshotu).
