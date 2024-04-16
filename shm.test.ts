import { SHM } from "./shm.ts";
import { assertEquals } from "jsr:@std/assert"; // "https://deno.land/std/assert/mod.ts";
// import FakeTimers from "npm:@sinonjs/fake-timers"; // 現在時刻に左右されるとき使う

Deno.test(
  "20240414 snapshot (needs --unstable-kv)",
  async (t) => {
    // const faketimer = FakeTimers.install();
    // faketimer.setSystemTime(new Date("2024-04-14"));

    const denokv = await Deno.openKv("./testdata/20240414.kv");
    const shm = new SHM();

    await t.step("html2kv", async () => {
      const logs: string[] = [];
      const origlog = globalThis.console.log;
      globalThis.console.log = (a1: string, a2 = "") => {
        logs.push(a1, a2);
      };

      const html = Deno.readTextFileSync("./testdata/20240414.html");
      await shm.html2kv(html, denokv);

      globalThis.console.log = origlog;
      assertEquals(
        logs,
        [
          "invalid href",
          '<a class="NU" href="https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_">■</a>',
        ],
      );
    });

    await t.step("kv2feed (rss)", async () => {
      const rss = (await shm.kv2feed(denokv)).rss2();
      Deno.writeTextFileSync("./testdata/20240414.rss", rss); // デバッグ用
      const expectedrss = Deno.readTextFileSync(
        "./testdata/20240414.expected.rss",
      );
      assertEquals(rss, expectedrss);
      Deno.removeSync("./testdata/20240414.rss"); // 失敗時には残る
    });

    await t.step("kv2feed (atom)", async () => {
      shm.selflink = "https://shm-rss.deno.dev/";

      const atom = (await shm.kv2feed(denokv)).rss2();
      Deno.writeTextFileSync("./testdata/20240414.atom", atom); // デバッグ用
      const expectedatom = Deno.readTextFileSync(
        "./testdata/20240414.expected.atom",
      );
      assertEquals(atom, expectedatom);
      Deno.removeSync("./testdata/20240414.atom"); // 失敗時には残る
    });

    denokv.close();
    Deno.removeSync("./testdata/20240414.kv");
  },
);
