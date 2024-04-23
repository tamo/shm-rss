// https://github.com/tamo/shm-rss/blob/main/shm.rb を Deno に移植してみた
// このファイル内容を https://dash.deno.com/ の Playground に置けば使える

import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1";
import { Feed, type FeedOptions, type Item } from "npm:feed";

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

  private kvstr = async (keys: string[]) =>
    (await this.kv.get<string>([this.myname, ...keys])).value ?? "";
  private kvnum = async (keys: string[]) =>
    (await this.kv.get<number>([this.myname, ...keys])).value ?? 0;

  failmsg = "(HTML のパースに失敗しました)";

  // handler で fetch した html を kv に set (保存期間 storedays 日)
  html2kv = async (html: string) => {
    const document = new DOMParser().parseFromString(html, "text/html")!;
    const lastmoddate = new Date(
      document.querySelector("p.INDENT-2EM small")!
        .textContent!
        .match(/Last modified: ((.*)\n.*\))/)?.[1]!,
    );
    const now = Date.now();

    // Kv の読み書きを少しでも減らしたい (set より get の方が安い)
    if (lastmoddate.getTime() == await this.kvnum(["lastmod"])) {
      await this.kv.set([this.myname, "lastfetch"], now);
      console.log("html2kv: skip same lastmod");
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

    const kvatom = this.kv.atomic(); // 書き込みは一気にしたい

    { // メタデータ
      const setifupdated = async (key: string, value: string) => {
        if (value != await this.kvstr([key])) {
          kvatom.set([this.myname, key], value);
        }
      };
      await setifupdated("title", document.title);
      await setifupdated(
        "description",
        document.querySelector("div.NORMAL")!.innerHTML, // 「追いかけてみるテストです」のあたり
      );
      kvatom.set([this.myname, "lastfetch"], now);
      kvatom.set([this.myname, "lastmod"], lastmoddate.getTime());
    }

    const storems = this.opts.storedays * 24 * 60 * 60 * 1000; // ミリ秒
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

      const oldjson = await this.kvstr(["item", ikey]) || '{"fetchdate": 0}';
      const olditem = JSON.parse(oldjson) as KvItem;
      item.fetchdate = olditem.fetchdate || (now - (index++) * 10000); // できるだけ順番を復元
      const newjson = JSON.stringify(item);

      if (newjson != oldjson) {
        kvatom.set(
          [this.myname, "item", ikey],
          newjson,
          { expireIn: storems },
        );
      }
    }

    await kvatom.commit();
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

  // 初回や html2kv 後に cachedfeed を更新
  kv2feed = async () => {
    const feed: SHMFeed = new Feed({
      id: this.opts.link!,
      link: this.opts.link!,
      copyright: this.opts.copyright!,
      title: await this.kvstr(["title"]),
      description: await this.kvstr(["description"]),
      updated: new Date(await this.kvnum(["lastmod"])),
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
    feed.lastfetch = await this.kvnum(["lastfetch"]);

    const kvitems: KvItem[] = [];
    for await (
      const itemstr of this.kv.list<string>({ prefix: [this.myname, "item"] })
    ) {
      kvitems.push(JSON.parse(itemstr.value) as KvItem);
    }
    kvitems.sort((a, b) =>
      (b.date * 2 + b.fetchdate!) - (a.date * 2 + a.fetchdate!) // できるだけ逆順に
    );
    for (const kvitem of kvitems) {
      const item = { ...kvitem, date: new Date(kvitem.date) } as Item;
      feed.addItem(item);
    }

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

  // 前回の fetch から ttl 分以上経ってたら fetch して kv に入れ cachedfeed にする
  // cachedfeed から response にする
  handler = async (req: Request) => {
    { // 起動直後のキャッシュ待ち (initsecs 秒までは待つが時間切れなら 503 エラー)
      let patience = this.opts.initsecs;
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
        return new Response(`try again in ${this.opts.initsecs} seconds`, {
          status: 503,
          headers: { "Retry-After": `${this.opts.initsecs}` },
        });
      }
    }

    try {
      const ttlms = this.opts.ttl! * 60 * 1000; // ミリ秒
      if (Date.now() - this.cachedfeed.lastfetch! > ttlms) {
        console.log(`fetch: ${new Date().toISOString()}`);
        await fetch(this.opts.link!)
          .then((res) => res.text())
          .then((html) => this.html2kv(html))
          .then(() => this.kv2feed())
          .then(() => console.log(`fetched: ${new Date().toISOString()}`));
      }
    } catch (error) {
      console.log(error);
    }

    if (this.cachedfeed.lastfetch) {
      try {
        if (new URL(req.url).pathname == this.opts.htmlpath) {
          return new Response(
            this.html(),
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        if (new URL(req.url).pathname == this.opts.jsonpath) {
          return new Response(
            this.json(),
            { headers: { "Content-Type": "application/feed+json" } },
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

type KvItem = Omit<Item, "date"> & {
  date: number; // Feed の Item では Date なので注意
  fetchdate?: number; // 記事の順番のため
};
type SHMOptions = Partial<FeedOptions> & {
  storedays: number;
  initsecs: number;
  htmlpath?: string;
  jsonpath?: string;
};
type SHMFeed = Feed & {
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
