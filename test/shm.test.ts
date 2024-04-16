import { html2kv, kv2feed } from "../shm.ts";
import { assertEquals } from "jsr:@std/assert"; // "https://deno.land/std/assert/mod.ts";
// import FakeTimers from "npm:@sinonjs/fake-timers";

Deno.test(
  "20240414 snapshot (needs --unstable-kv)",
  async (t) => {
    // const faketimer = FakeTimers.install();
    // faketimer.setSystemTime(new Date("2024-04-14"));

    const denokv = await Deno.openKv("./test/20240414.kv");

    await t.step("html2kv", async () => {
      const logs: string[] = [];
      const origlog = globalThis.console.log;
      globalThis.console.log = (a1: string, a2 = "") => {
        logs.push(a1, a2);
      };

      const origin = "https://www.st.ryukoku.ac.jp";
      const pathname = "/~kjm/security/memo/";
      const link = origin + pathname;
      const html = Deno.readTextFileSync("./test/20240414.html");
      await html2kv(html, link, denokv);

      globalThis.console.log = origlog;
      assertEquals(
        logs,
        [
          "invalid href",
          '<a class="NU" href="https://www.st.ryukoku.ac.jp/~kjm/security/memo/2024/04.html#20240412_">■</a>',
        ],
      );
    });

    await t.step("kv2feed", async () => {
      const rss = (await kv2feed(denokv)).rss2();
      Deno.writeTextFileSync("./test/20240414.rss", rss); // for debugging
      const expectedrss = Deno.readTextFileSync("./test/20240414.expected.rss");
      assertEquals(rss, expectedrss);
      Deno.removeSync("./test/20240414.rss"); // kept if assert fails
    });

    denokv.close();
    Deno.removeSync("./test/20240414.kv");
  },
);
