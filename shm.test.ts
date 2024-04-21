import { SHM } from "./shm.ts";
import { assertEquals } from "jsr:@std/assert"; // "https://deno.land/std/assert/mod.ts";
import FakeTimers from "npm:@sinonjs/fake-timers";

const faketimer = FakeTimers.install();

Deno.test(
  "2024-04-14 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      local: {
        date: "2024-04-14",
        log: [
          "initialized",
          "no title",
          '<a class="NU" href="https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_">■</a>',
        ],
      },
      srv: [
        {
          date: "2024-04-17", // update
          log: [
            "fetch: 2024-04-17T00:00:00.000Z",
            "fetched: 2024-04-17T00:00:00.000Z",
          ],
        },
        {
          date: "2024-04-18", // without update
          log: [
            "fetch: 2024-04-18T00:00:00.000Z",
            "html2kv: skip same lastmod",
            "fetched: 2024-04-18T00:00:00.000Z",
          ],
        },
        { date: "2024-04-18", log: [] },
      ],
    }, t),
);

Deno.test(
  "2024-04-17 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      local: { date: "2024-04-17", log: ["initialized"] },
      srv: [{ date: "2024-04-17", log: [] }],
    }, t),
);

type Snapshot = { date: string; log: string[] };
type Snapshots = { local: Snapshot; srv: Snapshot[] };

async function snaptester(s: Snapshots, t: Deno.TestContext) {
  faketimer.setSystemTime(new Date(s.local.date));

  const logs: string[] = [];
  const origlog = globalThis.console.log;
  globalThis.console.log = (...data: string[]) => {
    origlog(...data);
    logs.push(...data);
  };

  const denokv = await Deno.openKv(`./testdata/${s.local.date}.kv`);
  const shm = new SHM(denokv);

  await t.step(`${s.local.date} html2kv`, async () => {
    const html = Deno.readTextFileSync(`./testdata/${s.local.date}.html`);
    await shm.html2kv(html);
  });

  await t.step(`${s.local.date} kv2feed (rss)`, async () => {
    await shm.kv2feed();
    const rss = shm.rss();
    Deno.writeTextFileSync(`./testdata/${s.local.date}.rss`, rss); // デバッグ用
    const expectedrss = Deno.readTextFileSync(
      `./testdata/${s.local.date}.expected.rss`,
    );
    assertEquals(rss, expectedrss);
    Deno.removeSync(`./testdata/${s.local.date}.rss`); // 失敗時には残る
  });

  await t.step(`${s.local.date} kv2feed (atom)`, async () => {
    shm.delcache();
    shm.opts.feed = "https://shm-rss.deno.dev/";

    await shm.kv2feed();
    const atom = shm.rss();
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
  Deno.removeSync(`./testdata/${s.local.date}.kv`);
}
