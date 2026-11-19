import { describe, expect, it } from "vitest";

import { EMBED_REFERER, installEmbedReferer, isEmbedRequest, refererHeaders, type BeforeSendDetails, type BeforeSendListener } from "../src/embed/referer.js";

const embed = (over: Partial<BeforeSendDetails> = {}): BeforeSendDetails => ({
  url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
  resourceType: "subFrame",
  requestHeaders: { "User-Agent": "x", referer: "t3code://app/" },
  ...over,
});

describe("embed referer rule", () => {
  it("sets the referer on the embed frame request", () => {
    expect(refererHeaders(embed(), () => true)).toEqual({ "User-Agent": "x", Referer: EMBED_REFERER });
  });

  it("does nothing when the permission is off", () => {
    expect(refererHeaders(embed(), () => false)).toBeNull();
  });

  it.each([
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com.evil.test/embed/x",
    "https://evil.test/www.youtube-nocookie.com/embed/x",
    "https://www.youtube-nocookie.com/s/player/base.js",
    "https://www.youtube-nocookie.com/youtubei/v1/player",
    "http://www.youtube-nocookie.com/embed/x",
    "https://user:pw@www.youtube-nocookie.com/embed/x",
    "https://www.youtube-nocookie.com:8443/embed/x",
    "https://i.ytimg.com/vi/x/hqdefault.jpg",
    "not a url",
  ])("never matches %s", (url) => {
    expect(isEmbedRequest(url, "subFrame")).toBe(false);
    expect(refererHeaders(embed({ url }), () => true)).toBeNull();
  });

  it("ignores non-frame resource types", () => {
    expect(refererHeaders(embed({ resourceType: "xhr" }), () => true)).toBeNull();
    expect(refererHeaders(embed({ resourceType: "script" }), () => true)).toBeNull();
  });
});

describe("installEmbedReferer", () => {
  it("consults live state per request and passes others through", () => {
    let on = true;
    let listener: BeforeSendListener | undefined;
    let filter: { urls: string[] } | undefined;
    installEmbedReferer({ onBeforeSendHeaders: (f, l) => { filter = f; listener = l; } }, () => on);
    expect(filter?.urls).toEqual(["https://www.youtube-nocookie.com/embed/*"]);
    const run = (d: BeforeSendDetails): unknown => {
      let res: unknown;
      listener!(d, (r) => { res = r; });
      return res;
    };
    expect(run(embed())).toEqual({ requestHeaders: { "User-Agent": "x", Referer: EMBED_REFERER } });
    on = false;
    expect(run(embed())).toEqual({});
    on = true;
    expect(run(embed({ url: "https://example.com/embed/x" }))).toEqual({});
  });

  it("fails open when the state check throws", () => {
    let listener: BeforeSendListener | undefined;
    installEmbedReferer({ onBeforeSendHeaders: (_f, l) => { listener = l; } }, () => { throw new Error("boom"); });
    let res: unknown;
    listener!(embed(), (r) => { res = r; });
    expect(res).toEqual({});
  });
});
