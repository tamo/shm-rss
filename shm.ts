// https://github.com/tamo/shm-rss/blob/main/shm.rb を Deno に移植してみた
// このファイル内容を https://dash.deno.com/ の Playground に置けば使える

import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1";
import { Feed, type FeedOptions, type Item } from "npm:feed";
import { compress, decompress } from "https://deno.land/x/brotli@0.1.7/mod.ts";
import { assert } from "jsr:@std/assert/assert";

const refresh = false; // デバッグ用: 実行前に kv を全部消す

export class SHM {
  opts: SHMOptions = {
    link: "https://www.st.ryukoku.ac.jp/~kjm/security/memo/",
    copyright: "https://www.st.ryukoku.ac.jp/~kjm/security/memo/desc.html",
    feed: "", // "https://shm-rss.deno.dev/", // validator を黙らせる
    ttl: 60,
    storedays: 31,
    initsecs: 10,
    htmlpath: "/html",
    jsonpath: undefined,
  };

  constructor(public kv: Deno.Kv, partialopts?: Partial<SHMOptions>) {
    if (partialopts) {
      this.opts = { ...this.opts, ...partialopts };
    }
    this.kv2feed().then(() => console.log("initialized"));
  }

  myname = "shm";
  chunksize = 64000;
  failmsg = "(HTML のパースに失敗しました)";

  html2cache = (html: string) => {
    assert(this.cachedfeed);
    const document = new DOMParser().parseFromString(html, "text/html")!;
    const lastmoddate = new Date(
      document.querySelector("p.INDENT-2EM small")!
        .textContent!
        .match(/Last modified: ((.*)\n.*\))/)?.[1]!,
    );
    const now = Date.now();
    this.cachedfeed.lastfetch = now;

    if (lastmoddate.getTime() == this.cachedfeed.options.updated!.getTime()) {
      console.log("html2cache: skip same lastmod");
      return;
    }

    { // 相対パスを絶対パスに
      const baseurl = this.opts.link! + lastmoddate.toISOString()
        .replace(/^([0-9]{4})-([0-9]{2})-.*$/, "$1/$2.html");
      document.getElementsByTagName("a").forEach((a) => {
        const ahref = a.getAttribute("href");
        if (!ahref) return;
        a.setAttribute("href", new URL(ahref, baseurl).href);
      });
    }

    { // メタデータ
      this.cachedfeed.options.title = document.title;
      this.cachedfeed.options.description =
        document.querySelector("div.NORMAL")!.innerHTML; // 「追いかけてみるテストです」のあたり
      this.cachedfeed.options.updated = lastmoddate;
    }

    Array.prototype.reverse.call(
      document.querySelectorAll("a.NU") as Iterable<Element>,
    ).forEach((elem: Element, index) => {
      const item = this.elem2item(elem);
      if (item instanceof Error) {
        console.log(item.message, elem.outerHTML);
        return;
      }
      if (!item.title) return; // 親が H2 の場合、中の a.NU だけ処理

      assert(this.cachedfeed);
      const oldindex = this.cachedfeed.items
        .findIndex((citem) => citem.link == item.link);
      const tomodify = oldindex >= 0;
      const olditem = tomodify ? this.cachedfeed.items[oldindex] : undefined;
      item.fetchdate = olditem?.fetchdate || (now + index * 10000); // できるだけ順番を復元

      const newjson = JSON.stringify(item);
      const oldjson = JSON.stringify({
        ...olditem,
        date: olditem?.date.getTime(),
      });

      if (newjson != oldjson) {
        const cacheditem: CachedItem = {
          ...item,
          date: new Date(item.date),
        };
        if (tomodify) {
          console.log(`modified: ${newjson}`);
          this.cachedfeed!.items[oldindex] = cacheditem;
        } else {
          this.cachedfeed!.items.unshift(cacheditem);
        }
      }
    });
  };

  private elem2item = (elem: Element): KvItem | Error => {
    const parent = elem.parentElement;
    if (!parent) return new Error("no parent");
    if (parent.tagName == "H2") { // その中にまた a.NU がある
      return { title: "", link: "", date: 0 };
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

  // 引数は parent だけで足りるが bars も使って厳密にチェックしている
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

  private cachedfeed?: SHMFeed;

  // まとめて圧縮保存
  cache2kv = async () => {
    if (!this.cachedfeed) return;

    const lastmod = (await this.kv.get<number>([this.myname, "lastmod"])).value;
    if (lastmod == this.cachedfeed.options.updated!.getTime()) return;

    const kvatom = this.kv.atomic();
    {
      const jsonfeed = JSON.stringify(
        this.cachedfeed,
        (key, value) =>
        (key == "updated" || key == "date") ? Date.parse(value) : value,
    );
    const compfeed = compress(new TextEncoder().encode(jsonfeed));
    const chunknum = Math.ceil(compfeed.length / this.chunksize);
      [...Array(chunknum)]
        .map((_, i) => i * this.chunksize)
        .forEach((s, i) => {
          kvatom.set(
            [this.myname, "all", String(i).padStart(3, "0")],
            compfeed.slice(s, s + this.chunksize), // 大きくても大丈夫
          );
        });
      kvatom.delete([this.myname, "all", String(chunknum).padStart(3, "0")]); // オーバーラン防止
    }

    kvatom.set(
      [this.myname, "lastmod"],
      this.cachedfeed.options.updated!.getTime(),
    );

    const result = await kvatom.commit();
    console.log(`cache2kv: ${result.ok}`);
  };

  // cachedfeed を初期化
  kv2feed = async () => {
    const kvs = (await Array.fromAsync(
      this.kv.list<Uint8Array>({ prefix: [this.myname, "all"] }),
    )).filter((kv, index) => kv.key[2] == String(index).padStart(3, "0"));
    const u8a = new Uint8Array(
      kvs.reduce<number>((p, c) => p + c.value.length, 0),
    );
    kvs.forEach((u8chunk, index) =>
      u8a.set(u8chunk.value, index * this.chunksize)
    );
    const oldfeed = u8a.length
      ? JSON.parse(
        new TextDecoder().decode(decompress(u8a)),
        (key, value) =>
          (key == "updated" || key == "date")
            ? new Date(value as number)
            : value,
      )
      : undefined;

    const feed: SHMFeed = new Feed({
      id: this.opts.link!,
      link: this.opts.link!,
      copyright: this.opts.copyright!,
      title: oldfeed?.options.title ?? "",
      description: oldfeed?.options.description,
      updated: oldfeed?.options.updated ?? new Date(0),
      ttl: this.opts.ttl,
      // feed: this.opts.feed,
      ...(this.opts.feed
        ? {
          feedLinks: {
            rss: this.opts.feed,
            ...(this.opts.jsonpath
              ? { json: new URL(this.opts.jsonpath, this.opts.feed).href }
              : {}),
          },
        }
        : {}),
    });
    feed.lastfetch = oldfeed?.lastfetch ?? 0;

    const olditems: CachedItem[] = oldfeed?.items
      ? Array.from(oldfeed.items)
      : [];
    olditems.sort((a, b) =>
      (b.date.getTime() * 2 + b.fetchdate!) -
      (a.date.getTime() * 2 + a.fetchdate!) // できるだけ逆順に
    );
    const storems = this.opts.storedays * 24 * 60 * 60 * 1000; // ミリ秒
    const now = Date.now();
    olditems
      .filter((kvitem) => kvitem.date.getTime() + storems > now)
      .forEach((kvitem) => feed.addItem(kvitem));

    this.cachedfeed = feed;
  };

  rss = () => this.cachedfeed!.rss2();

  json = () => this.cachedfeed!.json1();

  html = () => {
    const json: FeedJson = JSON.parse(this.json());
    const htmlparts = [];
    htmlparts.push(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Previewing RSS of ${json.title}</title>
    ${
      this.opts.feed
        ? '<link rel="alternate" type="application/rss+xml" href="' +
          this.opts.feed + '" title="RSS">'
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
      this.opts.feed ? '<a href="' + this.opts.feed + '">RSS</a>' : "RSS"
    } of <a href="${json.home_page_url}">${json.title}</a></h1>
    ${
      this.opts.feed
        ? '<h2><a href="' + this.opts.feed + '">Get the RSS</a></h2>'
        : ""
    }
    <hr>
    <h3>description</h3>
    <blockquote id="channel_description">${json.description}</blockquote>
    <p><a href="https://github.com/tamo/shm-rss/">RSS 生成プロジェクトはこちら</a></p>
    <hr>`);

    json.items.forEach((i) =>
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

  // 前回の fetch から ttl 分以上経ってたら fetch して kv と cachedfeed を更新
  // cachedfeed から response にする
  handler = async (req: Request) => {
    try {
      await this.waitforcache(this.opts.initsecs);
    } catch {
      console.log("accessed before initialized");
      return new Response(`try again in ${this.opts.initsecs} seconds`, {
        status: 503,
        headers: { "Retry-After": `${this.opts.initsecs}` },
      });
    }
    assert(this.cachedfeed);

    try {
      const ttlms = this.opts.ttl! * 60 * 1000; // ミリ秒
      if (Date.now() - this.cachedfeed.lastfetch! > ttlms) {
        console.log(`fetch: ${new Date().toISOString()}`);
        await fetch(this.opts.link!)
          .then((res) => res.text())
          .then((html) => this.html2cache(html));
        console.log(`fetched: ${new Date().toISOString()}`);
        if (import.meta.main) {
          this.cache2kv(); // 待つ必要ない
        } else {
          await this.cache2kv(); // テストだと重複して Bad resource
        }
      }
    } catch (error) {
      console.log(error);
    }

    if (this.cachedfeed.lastfetch) {
      try {
        switch (new URL(req.url).pathname) {
          case this.opts.htmlpath:
            return new Response(this.html(), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          case this.opts.jsonpath:
            return new Response(this.json(), {
              headers: { "Content-Type": "application/feed+json" },
            });
          default:
            return new Response(this.rss(), {
              headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
            });
        }
      } catch (error) {
        console.log(error);
      }
    }

    return new Response("error", { status: 500 });
  };

  // 起動直後のキャッシュ待ち (initsecs 秒まで待つ)
  waitforcache = (timeout: number) =>
    new Promise((resolve, reject) =>
      (function checkcache(shm, patience, resolve, reject) {
        if (shm.cachedfeed) resolve(shm.cachedfeed);
        else if (patience < 1) reject("timeout");
        else {
          setTimeout(
            () => checkcache(shm, patience - 1, resolve, reject),
            1000,
          );
        }
      })(this, timeout, resolve, reject)
    );
}

type CachedItem = Item & {
  fetchdate?: number; // 記事の順番のため
};
type KvItem = Omit<CachedItem, "date"> & {
  date: number; // Feed の Item では Date なので注意
};
type SHMOptions = Partial<FeedOptions> & {
  storedays: number;
  initsecs: number;
  htmlpath?: string;
  jsonpath?: string;
};
type SHMFeed = Feed & {
  items: CachedItem[];
  lastfetch?: number;
};
type FeedJsonItem = {
  // content_html: string;
  url: string;
  title: string;
  summary: string;
  date_modified: string;
};
type FeedJson = {
  title: string;
  home_page_url: string;
  description: string;
  items: FeedJsonItem[];
};

// Deno Deploy 環境 (DENO_DEPLOYMENT_ID がある) ではその Kv を使用し、
// ローカル環境では
// DENO_KV_ACCESS_TOKEN (https://dash.deno.com/projects/<プロジェクト名>/kv 参照) があれば
// DENO_KV_URL の Kv を使用する (ので https://api.deno.com/databases/<GUID>/connect と設定)
// それ以外では ./shm.kv* を使用する
if (import.meta.main) { // test の場合は実行しない
  const localkv = Deno.env.get("DENO_DEPLOYMENT_ID")
    ? undefined
    : (Deno.env.get("DENO_KV_ACCESS_TOKEN")
      ? Deno.env.get("DENO_KV_URL")
      : "./shm.kv");
  const denokv = await Deno.openKv(localkv);
  const shm = new SHM(denokv);

  if (refresh) {
    const delatom = denokv.atomic();
    for await (const delent of denokv.list({ prefix: [shm.myname] })) {
      delatom.delete(delent.key);
    }
    await delatom.commit();
    console.log("kv deleted");
  }

  Deno.serve(shm.handler);
}
