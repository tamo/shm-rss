import { html2kv, kv2feed } from '../shm.ts';
// import FakeTimers from 'npm:@sinonjs/fake-timers';
import { assertEquals } from 'jsr:@std/assert'; // 'https://deno.land/std/assert/mod.ts';

Deno.test({
    name: '20240414 snapshot (needs --unstable-kv)',
    async fn() {
        // const faketimer = FakeTimers.install();
        // faketimer.setSystemTime(new Date('2024-04-14'));

        const denokv = await Deno.openKv('./test/20240414.kv');

        const origin = 'https://www.st.ryukoku.ac.jp';
        const pathname = '/~kjm/security/memo/';
        const link = origin + pathname;

        const html = Deno.readTextFileSync('./test/20240414.html');
        await html2kv(html, link, denokv);

        const rss = (await kv2feed(denokv)).rss2();
        Deno.writeTextFileSync('./test/20240414.rss', rss);

        denokv.close();
        Deno.removeSync('./test/20240414.kv');

        const expectedrss = Deno.readTextFileSync('./test/20240414.expected.rss');
        assertEquals(rss, expectedrss);
        Deno.removeSync('./test/20240414.rss');
    },
});
