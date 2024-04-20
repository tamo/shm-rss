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
  selflink: string;
  ttl: number;
  storedays: number;
  initsecs: number;
  kv: Deno.Kv;
  private cachedfeed?: FeedObj;

  constructor(
    kv: Deno.Kv,
    opts?: {
      selflink?: string;
      ttl?: number;
      storedays?: number;
      initsecs?: number;
    },
  ) {
    this.selflink = opts?.selflink ?? ""; // "https://shm-rss.deno.dev/"; // validator を黙らせる
    this.ttl = opts?.ttl ?? 60;
    this.storedays = opts?.storedays ?? 31;
    this.initsecs = opts?.initsecs ?? 10;
    this.kv = kv;
    this.kv2feed().then(() => console.log("initialized"));
  }

  myname = "shm";
  link = "https://www.st.ryukoku.ac.jp/~kjm/security/memo/";
  failmsg = "(HTML のパースに失敗しました)";

  html2kv = async (html: string) => {
    const document = new DOMParser().parseFromString(html, "text/html")!;
    const lastmoddate = new Date(
      document.querySelector("p.INDENT-2EM small")!
        .textContent!
        .match(/Last modified: ((.*)\n.*\))/)?.[1]!,
    );
    const now = Date.now();

    // Kv の読み書きを少しでも減らしたい
    if (
      lastmoddate.getTime() ==
        ((await this.kv.get<number>([this.myname, "lastmod"]))?.value || 0)
    ) {
      await this.kv.set([this.myname, "lastfetch"], now);
      console.log("html2kv: skip same lastmod");
      return;
    }

    { // 相対パスを絶対パスに
      const baseurl = this.link + lastmoddate.toISOString()
        .replace(/^([0-9]{4})-([0-9]{2})-.*$/, "$1/$2.html");
      document.getElementsByTagName("a").forEach((a) => {
        const ahref = a.getAttribute("href");
        if (!ahref) return;
        a.setAttribute("href", new URL(ahref, baseurl).href);
      });
    }

    let kvatom = this.kv.atomic();

    { // メタデータ
      const setifupdated = async (key: string, value: string) => {
        if (value != (await this.kv.get<string>([this.myname, key])).value) {
          kvatom = kvatom.set([this.myname, key], value);
        }
      };
      await setifupdated("title", document.title);
      await setifupdated("link", this.link);
      await setifupdated(
        "description",
        document.querySelector("div.NORMAL")!.innerHTML, // 「追いかけてみるテストです」のあたり
      );
      kvatom = kvatom.set([this.myname, "lastfetch"], now);
      kvatom = kvatom.set([this.myname, "lastmod"], lastmoddate.getTime());
    }

    const storems = this.storedays * 24 * 60 * 60 * 1000; // ミリ秒
    let index = 0; // Deno の querySelectorAll は Element にするために手間が必要
    for (
      const elem of (document.querySelectorAll("a.NU") as Iterable<Element>)
    ) {
      const item = this.elem2item(elem);
      if (item instanceof Error) {
        console.log(item.message, elem.outerHTML);
        continue;
      }
      if (!item.title) continue; // 親が H2 の場合、中の a.NU だけ処理

      const ikey = item.link.replace(/^.*#/, "");

      const oldjson = (await this.kv.get<string>([this.myname, "item", ikey]))
        .value ?? '{"fetchdate": 0}';
      const olditem = JSON.parse(oldjson) as Item;

      item.fetchdate = olditem.fetchdate || (now - (index++) * 10000); // できるだけ順番を復元
      const newjson = JSON.stringify(item);

      if (newjson != oldjson) {
        kvatom = kvatom.set(
          [this.myname, "item", ikey],
          newjson,
          { expireIn: storems },
        );
      }
    }

    await kvatom.commit();
  };

  private elem2item = (elem: Element): Item | Error => {
    const parent = elem.parentElement;
    if (!parent) return new Error("no parent");
    if (parent.tagName == "H2") { // その中にまた a.NU がある
      return { title: "", link: "", date: 0, description: "" };
    }

    const ititle = elem.nextElementSibling?.textContent;
    if (!ititle || !ititle.trim()) return new Error("no title");

    const ihref = elem.getAttribute("href");
    if (!ihref) return new Error("no href");
    const imatches = ihref.match(
      /^.*#([0-9]{4})([0-9]{2})([0-9]{2})(_+).*$/,
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

  private parent2desc = (p: Element, bars: number) => {
    if (bars == 2 && p.tagName == "P") { // 大部分の一行もの
      if (p.parentElement?.tagName == "LI") {
        return p.parentElement.innerHTML;
      }
    } else if (bars == 1 && p.tagName == "H3") { // 「いろいろ」とか「追記」
      const nextElement = p.nextElementSibling;
      if (nextElement?.tagName == "DIV" && nextElement.className == "BODY") {
        return nextElement.innerHTML;
      }
    }
    console.log("parent error", p, bars);
    return this.failmsg;
  };

  kv2feed = async () => {
    const kvstr = async (key: string) =>
      (await this.kv.get<string>([this.myname, key])).value || "";
    const kvnum = async (key: string) =>
      (await this.kv.get<number>([this.myname, key])).value || 0;
    const feed: FeedObj = {
      ...new Feed({
        title: await kvstr("title"),
        link: await kvstr("link"),
        description: await kvstr("description"),
        updated: new Date(await kvnum("lastmod")),
        ttl: this.ttl,
        feed: this.selflink,
      }),
      lastfetch: await kvnum("lastfetch"),
    };

    if (this.cachedfeed?.options.updated == feed.options.updated) {
      console.log("kv2feed: skip same lastmod");
      return;
    }

    const itemiter = this.kv.list<string>({ prefix: [this.myname, "item"] });
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

    this.cachedfeed = feed;
  };

  rss = () => this.cachedfeed!.rss2();

  html = () => {
    const json = JSON.parse(this.cachedfeed!.json1());
    const htmlparts = [];
    htmlparts.push(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Previewing RSS of ${json.title}</title>
    ${
      this.selflink
        ? '<link rel="alternate" type="application/rss+xml" href="' +
          this.selflink + '" title="RSS">'
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
      this.selflink ? '<a href="' + this.selflink + '">RSS</a>' : "RSS"
    } of <a href="${json.home_page_url}">${json.title}</a></h1>
    ${
      this.selflink
        ? '<h2><a href="' + this.selflink + '">Get the RSS</a></h2>'
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

  handler = async (req: Request) => {
    let patience = this.initsecs;
    const checkcache = (resolve: (_?: unknown) => void) => {
      if (this.cachedfeed || patience < 1) {
        resolve();
      } else {
        patience--;
        setTimeout(() => checkcache(resolve), 1000);
      }
    };
    await (new Promise(checkcache));
    if (!this.cachedfeed) {
      console.log("accessed before initialized");
      return new Response(`try again in ${this.initsecs} seconds`, {
        status: 503,
        headers: { "Retry-After": `${this.initsecs}` },
      });
    }

    try {
      const ttlms = this.ttl * 60 * 1000; // ミリ秒
      if (Date.now() - this.cachedfeed.lastfetch > ttlms) {
        console.log("fetch", new Date().toISOString());
        await fetch(this.link)
          .then((res) => res.text())
          .then((html) => this.html2kv(html))
          .then(() => this.kv2feed())
          .then(() => console.log("fetched", new Date().toISOString()));
      }
    } catch (error) {
      console.log(error);
    }

    if (this.cachedfeed.lastfetch) {
      try {
        if (new URL(req.url).pathname == "/html") {
          return new Response(
            this.html(),
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        return new Response(
          this.rss(),
          { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } },
        );
      } catch (error) {
        console.log(error);
      }
    }

    return new Response("error", { status: 500 });
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
  addItem: (item: FeedItem) => void;
  rss2: () => string;
  json1: () => string;
  options: { updated: Date };
  lastfetch: number;
};

if (import.meta.main) { // test の場合は実行しない
  const localkv = Deno.env.get("DENO_DEPLOYMENT_ID")
    ? undefined
    : (Deno.env.get("DENO_KV_ACCESS_TOKEN")
      ? Deno.env.get("DENO_KV_URL")
      : "./shm.kv");
  const denokv = await Deno.openKv(localkv);
  const shm = new SHM(denokv);

  if (refresh) {
    const delents = denokv.list({ prefix: [shm.myname] });
    const delproms: Promise<void>[] = [];
    for await (const delent of delents) {
      delproms.push(denokv.delete(delent.key));
    }
    await Promise.all(delproms);
    console.log("kv deleted");
  }

  Deno.serve(shm.handler);
}
