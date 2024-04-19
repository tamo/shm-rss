import { SHM } from "./shm.ts";
import { assertEquals } from "jsr:@std/assert"; // "https://deno.land/std/assert/mod.ts";

import FakeTimers from "npm:@sinonjs/fake-timers";
const faketimer = FakeTimers.install();
faketimer.setSystemTime(new Date("2024-04-17"));

Deno.test(
  "20240414 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      date: "20240414",
      log: [
        "initialized",
        "no title",
        '<a class="NU" href="https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_">■</a>',
      ],
      srvlog: false,
    }, t),
);

Deno.test(
  "20240417 snapshot (needs --unstable-kv)",
  async (t) =>
    await snaptester({
      date: "20240417",
      log: [
        "initialized",
      ],
      srvlog: [],
    }, t),
);

type Snapshot = { date: string; log: string[]; srvlog: string[] | false };
async function snaptester(s: Snapshot, t: Deno.TestContext) {
  const denokv = await Deno.openKv(`./testdata/${s.date}.kv`);
  const shm = new SHM(denokv);

  await t.step("html2kv", async () => {
    const logs: string[] = [];
    const origlog = globalThis.console.log;
    globalThis.console.log = (...data: string[]) => {
      origlog(...data);
      logs.push(...data);
    };

    const html = Deno.readTextFileSync(`./testdata/${s.date}.html`);
    await shm.html2kv(html);

    globalThis.console.log = origlog;
    assertEquals(logs, s.log);
  });

  await t.step("kv2feed (rss)", async () => {
    await shm.kv2feed();
    const rss = shm.rss();
    Deno.writeTextFileSync(`./testdata/${s.date}.rss`, rss); // デバッグ用
    const expectedrss = Deno.readTextFileSync(
      `./testdata/${s.date}.expected.rss`,
    );
    assertEquals(rss, expectedrss);
    Deno.removeSync(`./testdata/${s.date}.rss`); // 失敗時には残る
  });

  await t.step("kv2feed (atom)", async () => {
    shm.selflink = "https://shm-rss.deno.dev/";

    await shm.kv2feed();
    const atom = shm.rss();
    Deno.writeTextFileSync(`./testdata/${s.date}.atom`, atom); // デバッグ用
    const expectedatom = Deno.readTextFileSync(
      `./testdata/${s.date}.expected.atom`,
    );
    assertEquals(atom, expectedatom);
    Deno.removeSync(`./testdata/${s.date}.atom`); // 失敗時には残る
  });

  if (Array.isArray(s.srvlog)) {
    await t.step("serve", async (t) => {
      const logs: string[] = [];
      const origlog = globalThis.console.log;
      globalThis.console.log = (...data: string[]) => {
        origlog(...data);
        logs.push(...data);
      };

      await t.step("atom", async () => {
        const res = await shm.handler(
          new Request(new URL("http://localhost:8000/")),
        );

        assertEquals(res.status, 200);
        const expectedatom = Deno.readTextFileSync(
          `./testdata/${s.date}.expected.atom`,
        );
        assertEquals(await res.text(), expectedatom);
      });

      await t.step("html", async () => {
        const res = await shm.handler(
          new Request(new URL("http://localhost:8000/html")),
        );

        assertEquals(res.status, 200);
        const expectedhtml = Deno.readTextFileSync(
          `./testdata/${s.date}.expected.html`,
        );
        assertEquals(await res.text(), expectedhtml);
      });

      globalThis.console.log = origlog;
      assertEquals(logs, s.srvlog);
    });
  }

  denokv.close();
  Deno.removeSync(`./testdata/${s.date}.kv`);
}
