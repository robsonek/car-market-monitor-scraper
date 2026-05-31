// Tiny fetch stub. Tests construct one with a `routes` map (URL → Response or
// async handler) and pass it as `fetchImpl` to the listing/detail parsers. We
// never patch globalThis.fetch — both production entry points already accept a
// fetchImpl parameter, which is the cleanest seam and avoids cross-test
// pollution from leaked global mocks.

class StubResponse {
  constructor({ status = 200, body = "" } = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = body;
  }
  async text() {
    return this._body;
  }
}

// `routes` is a map keyed by exact URL (post normalization, with the forced
// `search[order]=created_at:desc` param). Each value is either a StubResponse,
// a function returning one, or a function returning a Promise.
//
// `calls` records every URL the production code requested, in order, so tests
// can assert pagination behavior, retry counts, header propagation, etc.
export function makeFetchStub(routes) {
  const calls = [];
  const stub = async (url) => {
    calls.push(url);
    const handler = routes[url];
    if (!handler) {
      // Return a 404 by default. The pagination tests rely on this — page=N
      // beyond what the fixture defines collapses to "out of range" which the
      // parser must treat as a hard error (NOT silent end-of-pagination).
      return new StubResponse({ status: 404, body: "<html>not found</html>" });
    }
    const res = typeof handler === "function" ? await handler(url) : handler;
    return res;
  };
  return { stub, calls, StubResponse };
}

export { StubResponse };
