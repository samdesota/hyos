import assert from "node:assert/strict";
import test from "node:test";

import type { CdpEndpoint, CdpTarget } from "../../capabilities/browser.js";
import { resolveCdpFrontendUrl } from "./cdp.js";

const endpoint: CdpEndpoint = { host: "localhost", port: 9223 };

const targetWith = (devtoolsFrontendUrl: string | null): CdpTarget => ({
  id: "target-1",
  type: "page",
  title: "HyOS Agent",
  url: "file:///renderer/index.html",
  devtoolsFrontendUrl,
  webSocketDebuggerUrl: null,
});

test("a relative devtools frontend resolves against the endpoint origin", () => {
  assert.equal(
    resolveCdpFrontendUrl(
      endpoint,
      targetWith("/devtools/inspector.html?ws=localhost:9223/devtools/page/1"),
    ),
    "http://localhost:9223/devtools/inspector.html?ws=localhost:9223/devtools/page/1",
  );
});

test("Electron's appspot frontend rewrites to the endpoint's bundled frontend", () => {
  assert.equal(
    resolveCdpFrontendUrl(
      endpoint,
      targetWith(
        "https://chrome-devtools-frontend.appspot.com/serve_rev/@abc123/inspector.html?ws=localhost:9223/devtools/page/1",
      ),
    ),
    "http://localhost:9223/devtools/inspector.html?ws=localhost:9223/devtools/page/1",
  );
});

test("a non-appspot absolute frontend passes through unchanged", () => {
  assert.equal(
    resolveCdpFrontendUrl(
      endpoint,
      targetWith("https://devtools.example.dev/inspector.html?ws=x"),
    ),
    "https://devtools.example.dev/inspector.html?ws=x",
  );
});

test("a target without a frontend throws", () => {
  assert.throws(
    () => resolveCdpFrontendUrl(endpoint, targetWith(null)),
    /exposes no devtools frontend/,
  );
});
