// https://github.com/tamo/shm-rss/blob/main/shm.rb を Deno に移植してみた
// このファイル内容を https://dash.deno.com/ の Playground に置けば使える

import {
  type Document,
  DOMParser,
  type Element,
} from "jsr:@b-fuze/deno-dom@0.1"; // "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

import { Feed } from "https://jspm.dev/feed";

// 前回の fetch から ttl 分以上経ってたら fetch して kv に入れる (保存期間 storedays 日)
// kv から feed を作成して response にする
// refresh が true ならそれらの前に kv を全部消してから始める (デバッグ中に使う)

const refresh = false;

export class SHM {
  selflink = ""; // "https://shm-rss.deno.dev/"; // 設定すると Atom 準拠で validator を黙らせる
  ttl = 60;
  storedays = 31;

  myname = "shm";
  link = "https://www.st.ryukoku.ac.jp/~kjm/security/memo/";

  html2kv = async (html: string, kv: Deno.Kv) => {
    const promises: Promise<Deno.KvCommitResult | Deno.KvCommitError>[] = [];

    const document = new DOMParser().parseFromString(html, "text/html")!;
    const lastmoddate = lastmod(document);
    const now = Date.now();
    /*
    // Kv の読み書きを少しでも減らしたい場合
    if (
      lastmoddate.getTime() ==
        ((await kv.get<number>([this.myname, "lastmod"]))?.value || 0)
    ) {
      await kv.set([this.myname, "lastfetch"], now);
      console.log("skip same lastmod");
      return;
    }
    */

    { // 相対パスを絶対パスに
      const baseurl = this.link + lastmoddate.toISOString()
        .replace(/^([0-9]{4})-([0-9]{2})-.*$/, "$1/$2.html");
      document.getElementsByTagName("a").forEach((a) => {
        const ahref = a.getAttribute("href");
        if (!ahref) return;
        a.setAttribute("href", new URL(ahref, baseurl).href);
      });
    }
    const docdesc = document.querySelector("div.NORMAL")!.innerHTML; // 「追いかけてみるテストです」のあたり
    promises.push(
      kv.atomic()
        .set([this.myname, "title"], document.title)
        .set([this.myname, "link"], this.link)
        .set([this.myname, "description"], docdesc)
        .set([this.myname, "lastfetch"], now)
        .set([this.myname, "lastmod"], lastmoddate.getTime())
        .commit(),
    );

    let index = 0; // Deno の querySelectorAll は Element にするために手間が必要
    for (
      const elem of (document.querySelectorAll("a.NU") as Iterable<Element>)
    ) {
      const item: Item | Error = elem2item(elem);
      if (item instanceof Error) {
        if (item.message) console.log(item.message, elem.outerHTML);
        continue;
      }

      const ikey = item.link.replace(/^.*#/, "");

      const olditem = (await kv.get([this.myname, "item", ikey])).value as {
        fetchdate: number;
      } | null;
      item.fetchdate = olditem?.fetchdate ?? (now - (index++) * 10000); // できるだけ順番を復元

      const storems = this.storedays * 24 * 60 * 60 * 1000; // ミリ秒
      promises.push(kv.set(
        [this.myname, "item", ikey],
        JSON.stringify(item),
        { expireIn: storems },
      ));
    }

    await Promise.all(promises);

    return;

    function lastmod(document: Document) {
      const lastmodstr = document.querySelector("p.INDENT-2EM small")!
        .textContent!
        .match(/Last modified: ((.*)\n.*\))/)?.[1]!;
      return new Date(lastmodstr);
    }

    function elem2item(elem: Element): Item | Error {
      const parent = elem.parentElement;
      if (!parent) return new Error("no parent");
      if (parent.tagName == "H2") return new Error(); // その中にまた a.NU がある

      const ititle = elem.nextElementSibling?.textContent;
      if (!ititle) return new Error("no title");

      const ihref = elem.getAttribute("href");
      if (!ihref) return new Error("no href");
      const imatches = ihref.match(
        /^.*#([0-9]{4})([0-9]{2})([0-9]{2})(_+)(.+)$/,
      );
      if (!imatches) return new Error("invalid href");
      const idate = `${imatches[1]}-${imatches[2]}-${imatches[3]}`; // アンカーから日付だけ取得する
      const ibars = imatches[4].length; // アンダーバーの数で記事の種類を判別

      return {
        title: ititle,
        link: ihref,
        date: Date.parse(idate),
        description: parent2desc(parent, ibars),
      };

      function parent2desc(p: Element, bars: number): string {
        if (bars == 2 && p.tagName == "P") { // 大部分の一行もの
          if (p.parentElement?.tagName == "LI") {
            return p.parentElement.innerHTML;
          }
        } else if (bars == 1 && p.tagName == "H3") { // 「いろいろ」とか「追記」
          const nextElement = p.nextElementSibling;
          if (
            nextElement?.tagName == "DIV" && nextElement.className == "BODY"
          ) {
            return nextElement.innerHTML;
          }
        }
        console.log("parent error", p, bars);
        return "(HTML のパースに失敗しました)";
      }
    }
  };

  kv2feed = async (kv: Deno.Kv): Promise<FeedObj> => {
    const kvval = async (key: string) =>
      (await kv.get<string>([this.myname, key])).value || "";
    const feed: FeedObj = new Feed({
      title: await kvval("title"),
      link: await kvval("link"),
      description: await kvval("description"),
      updated: new Date(parseInt(await kvval("lastmod"))),
      ttl: this.ttl,
      feed: this.selflink,
    });

    const itemiter = kv.list<string>({ prefix: [this.myname, "item"] });
    const items: FeedItem[] = [];
    for await (const itemstr of itemiter) {
      const item = JSON.parse(itemstr.value);
      item.date = new Date(item.date);
      items.push(item);
    }
    items.sort((a, b) =>
      (b.date.getTime() * 2 + b.fetchdate!) -
      (a.date.getTime() * 2 + a.fetchdate!) // できるだけ逆順に
    );
    for (const item of items) {
      feed.addItem(item);
    }

    return feed;
  };
}

type Item = {
  title: string;
  link: string;
  date: number; // あとで Date に変換
  description: string;
  fetchdate?: number; // 記事の順番のため
};
type FeedItem = Omit<Item, "date"> & {
  date: Date; // number のままでは Feed の Item にできない
};
type FeedObj = {
  rss2: () => string;
  addItem: (item: FeedItem) => void;
  lastfetch?: number;
};

if (import.meta.main) { // test の場合は実行しない
  const localkv = Deno.env.get("DENO_DEPLOYMENT_ID")
    ? undefined
    : (Deno.env.get("DENO_KV_ACCESS_TOKEN") // https://dash.deno.com/projects/<プロジェクト名>/kv 参照
      ? Deno.env.get("DENO_KV_URL") // https://api.deno.com/databases/<GUID>/connect
      : "./shm.kv");
  const shm = new SHM();

  if (refresh) {
    const delkv = await Deno.openKv(localkv);
    const delents = delkv.list({ prefix: [shm.myname] });
    const delproms: Promise<void>[] = [];
    for await (const delent of delents) {
      delproms.push(delkv.delete(delent.key));
    }
    await Promise.all(delproms);
    delkv.close();
    console.log("kv deleted");
  }

  const denokv = await Deno.openKv(localkv);
  let cachedfeed: FeedObj;
  try {
    cachedfeed = await shm.kv2feed(denokv);
  } catch {
    cachedfeed = {
      rss2: () => "",
      addItem: (_) => {},
      lastfetch: 0,
    };
  }

  Deno.serve(async (_req) => {
    try {
      const ttlms = shm.ttl * 60 * 1000; // ミリ秒
      const now = Date.now();
      if (now - (cachedfeed.lastfetch ?? 0) > ttlms) {
        if (
          cachedfeed.lastfetch || // cache がないだけじゃなくて本当に時間が経っている
          now - ((await denokv.get<number>(
                  [shm.myname, "lastfetch"],
                )).value ?? 0) > ttlms
        ) {
          console.log("fetch", new Date().toString());
          await fetch(shm.link)
            .then((res) => res.text())
            .then((html) => shm.html2kv(html, denokv));
        }

        cachedfeed = await shm.kv2feed(denokv);
        cachedfeed.lastfetch = now;
      }
      return new Response(
        cachedfeed.rss2(),
        { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
      );
    } catch (error) {
      console.log(error);
    }
    return new Response("error", { status: 500 });
  });
}
