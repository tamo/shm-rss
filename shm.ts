// https://github.com/tamo/shm-rss/blob/main/shm.rb を Deno に移植してみた
// このファイル内容を https://dash.deno.com/ の Playground に置けば使える

import {
    DOMParser,
    type Document,
    type Element,
} from 'https://deno.land/x/deno_dom/deno-dom-wasm.ts';

import { Feed } from 'https://jspm.dev/feed';

// 前回の fetch から ttl 分以上経ってたら fetch して kv に入れる (保存期間 storedays 日)
// kv から feed を作成して response にする
// refresh が true ならそれらの前に kv を全部消してから始める

const myname = 'shm';
const selflink = ''; // 'https://shm-rss.deno.dev/';
const refresh = false;
const ttl = 60;
const storedays = 31;

if (refresh) {
    const delkv = await Deno.openKv();
    const delents = delkv.list({ prefix: [myname] });
    const delproms: Promise<void>[] = [];
    for await (const delent of delents) {
        delproms.push(delkv.delete(delent.key));
    }
    await Promise.all(delproms);
    delkv.close();
    console.log('kv deleted');
}

const ttlms = ttl * 60 * 1000; // ミリ秒
const storems = storedays * 24 * 60 * 60 * 1000; // ミリ秒

const origin = 'https://www.st.ryukoku.ac.jp';
const pathname = '/~kjm/security/memo/';

type Item = {
    title: string,
    link: string,
    date: number, // あとで Date に変換
    description: string,
    fetchdate?: number, // 記事の順番のため
};

async function handler(_req: Request): Promise<Response> {
    try {
        const denokv = await Deno.openKv();

        const lastupdate = (await denokv.get<number>([myname, 'updated'])).value || 0;
        if (Date.now() - lastupdate > ttlms) {
            console.log('fetch', new Date().toString());
            const link = origin + pathname;
            await fetch(link)
                .then((res) => res.text())
                .then((html) => html2kv(html, link, denokv));
        }

        const rss = await kv2rss(denokv);
        return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    } catch (error) {
        console.log(error);
    }

    return new Response('error', { status: 500 });

    async function html2kv(html: string, link: string, kv: Deno.Kv) {
        const promises: Promise<Deno.KvCommitResult | Deno.KvCommitError>[] = [];

        const document = new DOMParser().parseFromString(html, 'text/html')!;
        absolutify(document); // 相対パスを絶対パスに
        const docdesc = document.querySelector('div.NORMAL')!.innerHTML; // 「追いかけてみるテストです」のあたり
        const now = Date.now();
        promises.push(kv.atomic()
            .set([myname, 'title'], document.title)
            .set([myname, 'link'], link)
            .set([myname, 'description'], docdesc)
            .set([myname, 'updated'], now)
            .commit());

        let index = 0; // Deno の querySelectorAll は Element にするために手間が必要
        for (const elem of (document.querySelectorAll('a.NU') as Iterable<Element>)) {
            const item: Item | Error = elem2item(elem);
            if (item instanceof Error) {
                if (item.message) console.log(item.message, elem);
                continue;
            }

            const ikey = item.link.replace(/^.*#/, '');

            const olditem = (await kv.get([myname, 'item', ikey])).value as { fetchdate: number } | null;
            item.fetchdate = olditem?.fetchdate ?? (now - (index++) * 10000); // できるだけ順番を復元

            promises.push(kv.set(
                [myname, 'item', ikey],
                JSON.stringify(item),
                { expireIn: storems }
            ));
        }

        await Promise.all(promises);

        return;

        function absolutify(document: Document) {
            const lastmod = document.querySelector('p.INDENT-2EM small')!.textContent!
                .match(/Last modified: ((.*)\n.*\))/)?.[1]!;
            const baseurl = origin + pathname + new Date(lastmod).toISOString()
                .replace(/^([0-9]{4})-([0-9]{2})-.*$/, '$1/$2.html');
            document.getElementsByTagName('a').forEach((a) => {
                const ahref = a.getAttribute('href');
                if (!ahref) return;
                a.setAttribute('href', new URL(ahref, baseurl).href);
            });
        }

        function elem2item(elem: Element): Item | Error {
            const parent = elem.parentElement;
            if (!parent) return new Error('no parent');
            if (parent.tagName == 'H2') return new Error(); // その中にまた a.NU がある

            const ititle = elem.nextSibling?.nextSibling?.textContent; // "》" の次が textnode で、その次がアンカー
            if (!ititle) return new Error('no title');

            const ihref = elem.getAttribute('href');
            if (!ihref) return new Error('no href');
            const imatches = ihref.match(/^.*#([0-9]{4})([0-9]{2})([0-9]{2})(_*)(.*)$/);
            if (!imatches || imatches.length < 5) return new Error('invalid href');
            const idate = `${imatches[1]}-${imatches[2]}-${imatches[3]}`; // アンカーから日付だけ取得する
            const ibars = imatches[4].length; // アンダーバーの数で記事の種類を判別

            return {
                title: ititle,
                link: ihref,
                date: Date.parse(idate),
                description: parent2desc(parent, ibars),
            };

            function parent2desc(p: Element, bars: number): string {
                if (bars == 2 && p.tagName == 'P') { // 大部分の一行もの
                    if (p.parentElement) {
                        return p.parentElement.innerHTML;
                    }
                } else if (bars == 1 && p.tagName == 'H3') { // 「いろいろ」とか「追記」
                    if (p.nextSibling?.nextSibling) {
                        return (p.nextSibling.nextSibling as Element).innerHTML;
                    }
                }
                console.log('parent error', p, bars);
                return '(HTML のパースに失敗しました)';
            }
        }

    }

    async function kv2rss(kv: Deno.Kv): Promise<string> {
        const kvval = async (key: string) => (await kv.get<string>([myname, key])).value || '';
        const feed = new Feed({
            title: await kvval('title'),
            link: await kvval('link'),
            description: await kvval('description'),
            updated: new Date(parseInt(await kvval('updated'))),
            ttl: ttl,
            feed: selflink,
        });

        type FeedItem = Omit<Item, 'date'> & {
            date: Date, // number のままでは Feed の Item にできない
        };
        const itemiter = kv.list<string>({ prefix: [myname, 'item'] });
        const items: FeedItem[] = [];
        for await (const itemstr of itemiter) {
            const item = JSON.parse(itemstr.value);
            item.date = new Date(item.date);
            items.push(item);
        }
        items.sort((a, b) =>
            b.date.getTime() * 2 + b.fetchdate!
            - a.date.getTime() * 2 - a.fetchdate! // できるだけ逆順に
        );
        for (const item of items) {
            feed.addItem(item);
        }

        return feed.rss2();
    }
}
Deno.serve(handler);
