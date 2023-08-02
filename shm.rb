#!/usr/bin/ruby
require 'nokogiri'
require 'open-uri'
require 'rss'
 
debug = true if ARGV[0] == '-d'
 
url = 'https://www.st.ryukoku.ac.jp/~kjm/security/memo/'
url = './index.html' if debug ### 何度もアクセスすると悪いので
ttl = '60' ### cron の設定に合わせて分単位で指定
out = 'shm.rss'
preview = 'shm.html'
html = '<html><body>'
 
open(url) do |origin|
  doc = Nokogiri::HTML(origin) ### 最悪でも new するのかな
 
  ### 相対パスを絶対パスに。格好いい方法ないのかな
  doc.css('a[href^="/~kjm/"]').each do |anc|
    anc['href'] = 'https://www.st.ryukoku.ac.jp' + anc['href']
    puts "prefixed: #{anc['href']}" if debug
  end
 
  rss = RSS::Maker.make('2.0') do |xml|
    xml.channel.title = doc.title
    xml.channel.link = url
    p xml.channel if debug
 
    ### 「追いかけてみるテストです」のあたりにしてみた
    xml.channel.description = doc.css('div.NORMAL').first.children

    html << <<~EOH
      <h1>Previewing RSS of #{xml.channel.title}</h1>
      <div id="link"><a href="#{xml.channel.link}">origin</a></div>
      <div id="description">description: #{xml.channel.description}</div>
    EOH

    doc.css('a.NU').each do |link|
      next if link.parent.name == "h2" ### その中にまた a.NU がある
 
      puts "processing: #{link}" if debug
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
 
      if debug
        puts " #{link.parent.name}:	Title: #{i.title}"
        puts "	Link: #{i.link}"
        puts "	Date: #{i.date}"
        puts "" ### description は長いから出力しない
      end

      html << <<~EOH
        <details>
          <summary>#{i.title}</summary>
          <div><a href="#{i.link}">#{i.date}</a></div>
          #{i.description}
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
