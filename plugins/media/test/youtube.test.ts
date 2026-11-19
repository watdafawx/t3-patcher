import { describe, expect, it } from "vitest";

import { embedUrl, parsePlayerMessage, parseStart, parseYouTube, playerCommand, targetKey, thumbUrl, watchUrl } from "../src/youtube.js";

const ID = "dQw4w9WgXcQ";
const LIST = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

describe("parseYouTube", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&feature=share`],
    [`http://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}`],
    [`youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abc123`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube.com/live/${ID}`],
    [`  https://www.youtube-nocookie.com/embed/${ID}  `],
  ])("accepts %s", (input) => {
    expect(parseYouTube(input)).toEqual({ kind: "video", id: ID });
  });

  it("keeps the start offset and a list on a video", () => {
    expect(parseYouTube(`https://youtu.be/${ID}?t=1m30s`)).toEqual({ kind: "video", id: ID, start: 90 });
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}&t=42`)).toEqual({ kind: "video", id: ID, start: 42 });
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}&list=${LIST}`)).toEqual({ kind: "video", id: ID, list: LIST });
  });

  it("parses playlists", () => {
    expect(parseYouTube(`https://www.youtube.com/playlist?list=${LIST}`)).toEqual({ kind: "playlist", list: LIST });
    expect(parseYouTube(`https://www.youtube.com/embed/videoseries?list=${LIST}`)).toEqual({ kind: "playlist", list: LIST });
  });

  it.each([
    [""],
    ["hello"],
    [ID], // a bare id is not a link
    [`https://evil.com/watch?v=${ID}`],
    [`https://youtube.com.evil.com/watch?v=${ID}`],
    [`https://evil.com/?u=https://youtube.com/watch?v=${ID}`],
    [`https://user:pw@www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com:8443/watch?v=${ID}`],
    [`javascript:alert(1)//youtube.com/watch?v=${ID}`],
    [`data:text/html,<script>alert(1)</script>`],
    [`ftp://www.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?v=${ID}extra`],
    [`https://www.youtube.com/watch?v=short`],
    [`https://www.youtube.com/watch?v=${ID.slice(0, 10)}"`],
    [`https://www.youtube.com/watch?v=<script>`],
    [`https://www.youtube.com/watch`],
    [`https://www.youtube.com/channel/UC1234567890123456789012`],
    [`https://www.youtube.com/playlist?list=short`],
    [`https://youtu.be/${ID}/more`],
    [`https://youtu.be/${ID}\nhttps://evil.com`],
    [`https://www.youtube.com/watch?v=${ID} x`],
    ["https://www.youtube.com/watch?v=" + "a".repeat(400)],
  ])("rejects %j", (input) => {
    expect(parseYouTube(input)).toBeNull();
  });

  it("ignores a malformed list but keeps the video", () => {
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}&list=bad%22id`)).toEqual({ kind: "video", id: ID });
  });
});

describe("parseStart", () => {
  it("handles seconds and h/m/s forms and rejects junk", () => {
    expect(parseStart("90")).toBe(90);
    expect(parseStart("1h2m3s")).toBe(3723);
    expect(parseStart("2m")).toBe(120);
    expect(parseStart("")).toBeUndefined();
    expect(parseStart("abc")).toBeUndefined();
    expect(parseStart("-5")).toBeUndefined();
    expect(parseStart("999999")).toBeUndefined(); // over a day
    expect(parseStart("0")).toBeUndefined();
  });
});

describe("urls", () => {
  it("builds the nocookie embed with the api flag and optional params", () => {
    const u = new URL(embedUrl({ kind: "video", id: ID }, { autoplay: true, start: 12.9, origin: "https://app.example" }));
    expect(u.origin).toBe("https://www.youtube-nocookie.com");
    expect(u.pathname).toBe(`/embed/${ID}`);
    expect(u.searchParams.get("enablejsapi")).toBe("1");
    expect(u.searchParams.get("autoplay")).toBe("1");
    expect(u.searchParams.get("start")).toBe("12");
    expect(u.searchParams.get("origin")).toBe("https://app.example");
  });
  it("never forwards a non-http origin (t3code://)", () => {
    const u = new URL(embedUrl({ kind: "video", id: ID }, { origin: "t3code://app" }));
    expect(u.searchParams.has("origin")).toBe(false);
  });
  it("uses videoseries for playlists", () => {
    const u = new URL(embedUrl({ kind: "playlist", list: LIST }));
    expect(u.pathname).toBe("/embed/videoseries");
    expect(u.searchParams.get("list")).toBe(LIST);
  });
  it("thumbnail only for videos, watch url and key", () => {
    expect(thumbUrl({ kind: "video", id: ID })).toBe(`https://i.ytimg.com/vi/${ID}/mqdefault.jpg`);
    expect(thumbUrl({ kind: "playlist", list: LIST })).toBeNull();
    expect(watchUrl({ kind: "video", id: ID })).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(targetKey({ kind: "video", id: ID })).toBe(`v:${ID}`);
    expect(targetKey({ kind: "playlist", list: LIST })).toBe(`list:${LIST}`);
  });
});

describe("player messages", () => {
  it("builds commands", () => {
    expect(JSON.parse(playerCommand("playVideo"))).toEqual({ event: "command", func: "playVideo", args: "" });
  });
  it("reads state and time updates, ignores the rest", () => {
    expect(parsePlayerMessage('{"event":"onStateChange","info":1}')).toEqual({ playing: true });
    expect(parsePlayerMessage({ event: "onStateChange", info: 2 })).toEqual({ playing: false });
    expect(parsePlayerMessage({ event: "infoDelivery", info: { currentTime: 12.5, playerState: 1 } })).toEqual({ playing: true, currentTime: 12.5 });
    expect(parsePlayerMessage({ event: "infoDelivery", info: { currentTime: -1 } })).toBeNull();
    expect(parsePlayerMessage("not json")).toBeNull();
    expect(parsePlayerMessage(null)).toBeNull();
    expect(parsePlayerMessage({ event: "other" })).toBeNull();
  });
});
