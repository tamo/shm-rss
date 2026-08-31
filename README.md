# [セキュ memo](https://www.st.ryukoku.ac.jp/~kjm/security/memo/) の RSS 生成

## [Deno 版](https://github.com/tamo/shm-rss/blob/main/shm.ts)

https://shm-rss.tamo.deno.net/ に生成しています。

こちらは Deno 環境の TypeScript です。
Deno Deploy の Playground にコピペして kv を attach するだけで使えます。

問題発生時の切り分け用に https://shm-rss.tamo.deno.net/html というプレビュー的 HTML もあります。

## [Ruby 版](https://github.com/tamo/shm-rss/blob/main/shm.rb)

https://tamo.github.io/shm-rss/shm.rss に生成しています。
HTML に Nokogiri をかけているだけです。

問題発生時の切り分け用に https://tamo.github.io/shm-rss/ というプレビュー的 HTML もあります。

更新のログは [Actions](https://github.com/tamo/shm-rss/actions) を参照ください。
