// https://github.com/tamo/shm-rss/blob/main/shm.rb を Deno に移植してみた
// このファイル内容を https://dash.deno.com/ の Playground に置けば使える

// Deno Deploy 環境 (DENO_DEPLOYMENT_ID がある) ではその Kv を使用し、
// ローカル環境では
// DENO_KV_ACCESS_TOKEN (https://dash.deno.com/projects/<プロジェクト名>/kv 参照) があれば
// DENO_KV_URL の Kv を使用する (ので https://api.deno.com/databases/<GUID>/connect と設定)
// それ以外では ./shm.kv* を使用する

import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1"; // "https://deno.land/x/deno_dom/deno-dom-wasm.ts";
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
  failmsg = "(HTML のパースに失敗しました)";

  html2kv = async (html: string, kv: Deno.Kv) => {
    const promises: Promise<Deno.KvCommitResult | Deno.KvCommitError>[] = [];

    const document = new DOMParser().parseFromString(html, "text/html")!;
    const lastmoddate = new Date(
      document.querySelector("p.INDENT-2EM small")!
        .textContent!
        .match(/Last modified: ((.*)\n.*\))/)?.[1]!,
    );
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
      const item: Item | Error = this.elem2item(elem);
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
  };

  private elem2item = (elem: Element): Item | Error => {
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
      description: this.parent2desc(parent, ibars),
    };
  };

  private parent2desc = (p: Element, bars: number): string => {
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
    return this.failmsg;
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

  feed2html = (feed: FeedObj) => {
    const json = JSON.parse(feed.json1());
    const htmlparts = [];
    htmlparts.push(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Previewing RSS of ${json.title}</title>
    ${
      json.feed_url
        ? '<link rel="alternate" type="application/rss+xml" href="' +
          json.feed_url + '" title="RSS">'
        : ""
    }
    <style>
      blockquote {
        border-style: solid;
        border-width: thin;
      }
      div.date {
        font-size: x-small;
      }
      details[open] summary {
        background-color: red;
      }
    </style>
  </head>
  <body id="body">
    <h1>Previewing ${
      json.feed_url ? '<a href="' + json.feed_url + '">RSS</a>' : "RSS"
    } of <a href="${json.home_page_url}">${json.title}</a></h1>
    ${
      json.feed_url
        ? '<h2><a href="' + json.feed_url + '">Get the RSS</a></h2>'
        : ""
    }
    <hr>
    <h3>description</h3>
    <blockquote id="channel_description">${json.description}</blockquote>
    <p><a href="https://github.com/ttamo/shm-rss/">RSS 生成プロジェクトはこちら</a></p>
    <hr>`);

    (json.items as Array<{
      title: string;
      url: string;
      summary: string;
      date_modified: string;
    }>).forEach((i) =>
      htmlparts.push(`
    <details ${(i.summary == this.failmsg) ? "open=true" : ""}>
      <summary>${i.title}</summary>
      <div class="date">
        <a href="${i.url}">${i.date_modified}</a>
      </div>
      <blockquote class="description">
        ${i.summary}
      </blockquote>
    </details>`)
    );

    htmlparts.push(`
  </body>
</html>`);

    return "".concat(...htmlparts);
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
  json1: () => string;
  addItem: (item: FeedItem) => void;
  lastfetch?: number;
};

if (import.meta.main) { // test の場合は実行しない
  const localkv = Deno.env.get("DENO_DEPLOYMENT_ID")
    ? undefined
    : (Deno.env.get("DENO_KV_ACCESS_TOKEN")
      ? Deno.env.get("DENO_KV_URL")
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
      json1: () => "",
      addItem: (_) => {},
      lastfetch: 0,
    };
  }

  Deno.serve(async (req) => {
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
    } catch (error) {
      console.log(error);
    }

    if (cachedfeed.lastfetch) {
      try {
        if (new URL(req.url).pathname == "/html") {
          return new Response(
            shm.feed2html(cachedfeed),
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        return new Response(
          cachedfeed.rss2(),
          { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
        );
      } catch (error) {
        console.log(error);
      }
    }

    return new Response("error", { status: 500 });
  });
}
