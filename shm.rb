#!/usr/bin/ruby
require 'nokogiri'
require 'open-uri'
require 'rss'

url = 'https://www.st.ryukoku.ac.jp/~kjm/security/memo/'
ttl = '60' ### cron の設定に合わせて分単位で指定
out = 'shm.rss'
preview = 'shm.html'
html = <<~EOH
  <!doctype html>
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <title>Previewing RSS of #{url}</title>
      <style>
        blockquote {
          border-style: solid;
          border-width: thin;
        }
        div.date {
          font-size: x-small;
        }
      </style>
    </head>
    <body>
EOH

URI.open(url) do |origin|
  doc = Nokogiri::HTML(origin) ### 最悪でも new するのかな

  ### 相対パスを絶対パスに。格好いい方法ないのかな
  doc.css('a[href^="/~kjm/"]').each do |anc|
    anc['href'] = 'https://www.st.ryukoku.ac.jp' + anc['href']
  end

  rss = RSS::Maker.make('2.0') do |xml|
    xml.channel.title = doc.title
    xml.channel.link = url

    ### 「追いかけてみるテストです」のあたりにしてみた
    xml.channel.description = doc.css('div.NORMAL').first.children

    html << <<~EOH
      <h1>Previewing RSS of <a href="#{xml.channel.link}">#{xml.channel.title}</a></h1>
      <hr />
      <h3>description</h3>
      <blockquote id="channel_description">#{xml.channel.description}</blockquote>
      <hr />
    EOH

    doc.css('a.NU').each do |link|
      next if link.parent.name == "h2" ### その中にまた a.NU がある

      i = xml.items.new_item
      ### "》" の次が空 span で、その次がリンクかな
      i.title = link.next.next.content
      i.link = link['href']
      if link.parent.name == 'p' ### 大部分の一行もの
        i.description = link.parent.parent.children
      elsif link.parent.name == 'h3' ### 「いろいろ」とか「追記」
        i.description = link.parent.next.next
      else
        i.description = '(HTML のパースに失敗しました)'
      end
      ### アンカーから日付だけ取得するハック
      i.date = Time.parse(/#([0-9]{8})/.match(link['href'])[1])

      html << <<~EOH
        <details>
          <summary>#{i.title}</summary>
          <div class="date">
            <a href="#{i.link}">#{i.date}</a>
          </div>
          <blockquote class="description">
            #{i.description}
          </blockquote>
        </details>
      EOH
    end

    xml.channel.ttl = ttl
    html << "</body></html>"
  end

  File.open(out, 'w') do |f|
    f.write(rss.to_s)
  end

  File.open(preview, 'w') do |f|
    f.write(html)
  end
end
