import { SHM } from "./shm.ts";
import { assertEquals } from "jsr:@std/assert";
import FakeTimers from "npm:@sinonjs/fake-timers";

const faketimer = FakeTimers.install();

Deno.test(
  "2024-04-14 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      local: {
        date: "2024-04-14",
        lastmod: "2024-04-12T11:10:50.000Z",
        log: [
          "initialized",
          "no title",
          '<a class="NU" href="https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_">■</a>',
          "cache2kv: true",
          "initialized",
        ],
      },
      srv: [
        {
          date: "2024-04-17", // update
          lastmod: "2024-04-17T10:47:18.000Z",
          log: [
            "fetch: 2024-04-17T00:00:00.000Z",
            'modified: {"title":"Toward greater transparency: Adopting the CWE standard for Microsoft CVEs","link":"https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240411__msrc","date":1712793600000,"description":"<p>\\n      <a class=\\"NU\\" href=\\"https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240411__msrc\\">》</a>\\n<a name=\\"20240411__msrc\\" href=\\"https://msrc.microsoft.com/blog/2024/04/toward-greater-transparency-adopting-the-cwe-standard-for-microsoft-cves/\\">Toward greater transparency: Adopting the CWE standard for Microsoft CVEs</a>\\n      (MSRC, 4/8)\\n      </p>\\n      <p>\\n      　2024.04.16 追記: <a href=\\"https://forest.watch.impress.co.jp/docs/news/1584488.html\\">Microsoft、セキュリティレポートに「CWE」標準を採用、脆弱性のタイプを分類して表示</a>\\n      (窓の杜, 4/16)\\n      </p>\\n\\n\\n  ","fetchdate":1713053260000}',
            'modified: {"title":"\\nChrome Stable Channel Update for Desktop\\n","link":"https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_chrome","date":1712880000000,"description":"\\n<p>\\n　Chrome 123.0.6312.122/.123 (Windows) 123.0.6312.122/.123/.124 (Mac)  123.0.6312.122 (Linux)\\n公開。3 件のセキュリティ修正を含む。関連:\\n</p>\\n<ul>\\n  <li><p>\\n      <a href=\\"https://chromereleases.googleblog.com/2024/04/chrome-for-android-update_10.html\\">\\n      Chrome for Android Update </a>\\n      (Google, 2024.04.10)。Chrome 123 (123.0.6312.118) for Android。\\n      </p>\\n\\n</li></ul>\\n\\n<div class=\\"TSUIKI\\">2024.04.16 追記:</div>\\n<p>\\n　関連:\\n</p>\\n<ul>\\n  <li><p>\\n      <a href=\\"https://forest.watch.impress.co.jp/docs/news/1584121.html\\">「Microsoft Edge」にセキュリティ更新 ～「Angle」のヒープバッファーオーバーフローなど\\n\\n      v123.0.2420.97への更新を </a>\\n      (窓の杜, 2024.04.15)\\n      </p>\\n\\n</li></ul>\\n\\n","fetchdate":1713053300000}',
            "fetched: 2024-04-17T00:00:00.000Z",
            "cache2kv: true",
          ],
        },
        {
          date: "2024-04-18", // without update
          lastmod: "2024-04-17T10:47:18.000Z",
          log: [
            "fetch: 2024-04-18T00:00:00.000Z",
            "html2cache: skip same lastmod",
            "fetched: 2024-04-18T00:00:00.000Z",
          ],
        },
        { date: "2024-04-18", lastmod: "2024-04-17T10:47:18.000Z", log: [] },
      ],
    }, t),
);

Deno.test(
  "2024-04-17 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      local: {
        date: "2024-04-17",
        lastmod: "2024-04-17T10:47:18.000Z",
        log: [
          "initialized",
          "cache2kv: true",
          "initialized",
        ],
      },
      srv: [{
        date: "2024-04-17",
        lastmod: "2024-04-17T10:47:18.000Z",
        log: [],
      }],
    }, t),
);

type Snapshot = { date: string; lastmod: string; log: string[] };
type Snapshots = { local: Snapshot; srv: Snapshot[] };

async function snaptester(s: Snapshots, t: Deno.TestContext) {
  faketimer.setSystemTime(new Date(s.local.date));

  const logs: string[] = [];
  const origlog = globalThis.console.log;
  globalThis.console.log = (...data: string[]) => {
    origlog(...data);
    logs.push(...data);
  };

  const kvpath = `./testdata/${s.local.date}.kv`;
  try {
    Deno.removeSync(kvpath);
  } catch (e) {
    if (e.name != "NotFound") throw e;
  }
  const denokv = await Deno.openKv(kvpath);
  const shm = new SHM(denokv);
  await shm.initcache();

  await t.step(`${s.local.date} html2cache`, () => {
    const html = Deno.readTextFileSync(`./testdata/${s.local.date}.html`);
    shm.html2cache(html);
    const rss = shm.getrss();
    Deno.writeTextFileSync(`./testdata/${s.local.date}.rss`, rss); // デバッグ用
    const expectedrss = Deno.readTextFileSync(
      `./testdata/${s.local.date}.expected.rss`,
    );
    assertEquals(rss, expectedrss);
    assertEquals(shm.getlastmod()?.toISOString(), s.local.lastmod);
    Deno.removeSync(`./testdata/${s.local.date}.rss`); // 失敗時には残る
  });

  await t.step(`${s.local.date} kv2feed (atom)`, async () => {
    await shm.cache2kv();
    shm.opts.feed = "https://shm-rss.deno.dev/";
    await shm.initcache();

    const atom = shm.getrss();
    Deno.writeTextFileSync(`./testdata/${s.local.date}.atom`, atom); // デバッグ用
    const expectedatom = Deno.readTextFileSync(
      `./testdata/${s.local.date}.expected.atom`,
    );
    assertEquals(atom, expectedatom);
    Deno.removeSync(`./testdata/${s.local.date}.atom`); // 失敗時には残る
  });

  globalThis.console.log = origlog;
  assertEquals(logs, s.local.log);

  for (const [i, srv] of s.srv.entries()) {
    await t.step(`(${i}) ${srv.date} serve`, async (t) => {
      faketimer.setSystemTime(new Date(srv.date));

      globalThis.fetch = (_input: unknown, _init?: unknown) => {
        const html = Deno.readTextFileSync(`./testdata/${s.srv[0].date}.html`);
        return new Promise((resolve) => resolve(new Response(html)));
      };

      const logs: string[] = [];
      const origlog = globalThis.console.log;
      globalThis.console.log = (...data: string[]) => {
        origlog(...data);
        logs.push(...data);
      };

      await t.step(`(${i}) ${srv.date} atom`, async () => {
        const res = await shm.handler(
          new Request(new URL("http://localhost:8000/")),
        );

        assertEquals(res.status, 200);
        assertEquals(res.headers.get("etag"), `W/"${srv.lastmod}"`);
        const expectedatom = Deno.readTextFileSync(
          `./testdata/${s.srv[0].date}.expected.atom`,
        );
        assertEquals(await res.text(), expectedatom);
      });

      await t.step(`(${i}) ${srv.date} html`, async () => {
        const res = await shm.handler(
          new Request(new URL("http://localhost:8000/html")),
        );

        assertEquals(res.status, 200);
        const expectedhtml = Deno.readTextFileSync(
          `./testdata/${s.srv[0].date}.expected.html`,
        );
        assertEquals(await res.text(), expectedhtml);
      });

      globalThis.console.log = origlog;
      assertEquals(logs, srv.log);
    });
  }

  denokv.close();
  Deno.removeSync(kvpath);
}
