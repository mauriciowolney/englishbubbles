/* sw.js — the service worker: it keeps a copy of the whole app on the phone so it opens and plays offline.
   build.py fills in VERSION (a fingerprint of the app), FILES (every file in dist/) and FONTS (the Google Fonts
   stylesheets the games use). A new VERSION = a new copy: phones download it in the background, and the menu
   offers "Update" (or it takes over the next time the app is opened from scratch). */
const VERSION = "e45fc47d49";
const FILES = [
 "./",
 "games/articles.html",
 "games/comparatives.html",
 "games/conditionals.html",
 "games/core-words.html",
 "games/false-friends.html",
 "games/gerund-infinitive.html",
 "games/idioms.html",
 "games/irregular-past.html",
 "games/linking-words.html",
 "games/phrasal-verbs.html",
 "games/prepositions.html",
 "games/present-perfect.html",
 "games/pronouns.html",
 "games/questions.html",
 "games/silent-letters.html",
 "games/stressed-syllables.html",
 "games/there-or-have.html",
 "games/verb-bubbles.html",
 "games/verb-wheel.html",
 "games/word-families.html",
 "icons/apple-touch-icon.png",
 "icons/favicon-32.png",
 "icons/favicon-64.png",
 "icons/game-158.png",
 "icons/game-165.png",
 "icons/game-172.png",
 "icons/game-175.png",
 "icons/game-188.png",
 "icons/game-21.png",
 "icons/game-220.png",
 "icons/game-228.png",
 "icons/game-250.png",
 "icons/game-287.png",
 "icons/game-30.png",
 "icons/game-337.png",
 "icons/game-37.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/logo-102.png",
 "icons/maskable-192.png",
 "icons/maskable-512.png",
 "index.html",
 "manifest.json"
];
const FONTS = [
 "https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&display=swap",
 "https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap"
];
const CACHE = "eb-app-" + VERSION;
const FONT_CACHE = "eb-fonts-1";
const AUDIO_CACHE = "eb-audio-1";

// A clip: the phone's copy, else the internet (keeping a copy). Audio players often ask for a part of the file
// ("Range: bytes=0-"); the whole file is fetched and kept, and the part asked for is cut from it.
async function clip(req) {
  const cache = await caches.open(AUDIO_CACHE);
  const key = req.url.split("#")[0];
  let res = await cache.match(key, { ignoreSearch: true });
  if (!res) {
    try {
      res = await fetch(key);
    } catch (e) {
      return new Response("", { status: 504 });
    }
    if (!res.ok) return res;
    await cache.put(key, res.clone()).catch(() => {});
  }
  const range = req.headers.get("range");
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res;
  const blob = await res.blob();
  const start = m[1] === "" ? Math.max(0, blob.size - Number(m[2])) : Number(m[1]);
  const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
  if (start >= blob.size) return new Response("", { status: 416, headers: { "Content-Range": "bytes */" + blob.size } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || (/\.mp3$/i.test(key) ? "audio/mpeg" : "audio/ogg"),
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

// Install: download every file of this version (bypassing the browser's HTTP cache) and the fonts.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    await cacheFonts().catch(() => {});          // fonts are a nice-to-have: never fail the install for them
  })());
});

async function cacheFonts() {
  const cache = await caches.open(FONT_CACHE);
  for (const url of FONTS) {
    if (await cache.match(url, { ignoreVary: true })) continue;
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) continue;
    await cache.put(url, res.clone());
    const css = await res.text();
    const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]);
    await Promise.all(files.map(async (f) => {
      if (await cache.match(f)) return;
      const r = await fetch(f, { mode: "cors" });
      if (r.ok) await cache.put(f, r);
    }));
  }
}

// Activate: delete the copies of older versions.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("eb-app-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// The menu's "Update" button asks the waiting new version to take over now.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
  if (event.data === "version" && event.source) event.source.postMessage({ version: VERSION });
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: from the phone's copy; otherwise from the internet, keeping a copy for next time.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response("", { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;     // other sites (dictionary links): the normal way

  // A recorded-voice clip (games/<name>-audio/<clip>.ogg): not in the offline copy (all games' clips together are
  // 100+ MB). The first time a student hears it, it is downloaded and kept in its own cache, which app updates
  // never delete (clip names are fingerprints of what they say, so a kept clip is never out of date). Offline and
  // never heard: the request fails and the game reads the sentence with the browser voice instead.
  if (/-audio\//.test(url.pathname)) {
    event.respondWith(clip(req));
    return;
  }

  // The app's own files: always the copy of this version (so every page matches), else the internet.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(req, { ignoreSearch: true });
    if (!hit && req.mode === "navigate") {
      hit = await cache.match(url.pathname.endsWith("/") ? "./" : "index.html", { ignoreSearch: true })
        || await cache.match("index.html");
    }
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      return (await cache.match("index.html")) || new Response("Offline", { status: 503 });
    }
  })());
});
