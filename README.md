# Cloudflare vless 代理节点
## 一、简介
### 1. 功能
利用Cloudflare的pages的全球CDN节点搭建vless类型VPN，包含美国、日本、中国台湾、中国香港、新加坡、马来西亚、韩国、俄罗斯等地节点，自动生成Clash配置
### 2. 代码改动
worker.js来自https://github.com/keyzf/cf-vless/tree/main
美化了界面，修改了部分内容，增加了许多新节点，目前有22个CDN节点
### 3. 节点预览
<img width="600" alt="image" src="https://github.com/user-attachments/assets/90c271b1-09bd-48a6-b269-23cbcfb4666a" />  

节点网速测试（由speedtest.im提供测速）  
 
<img width="600" alt="image" src="https://github.com/user-attachments/assets/8a0e2643-ff3a-49b8-a3af-b9979f51cbfb" />
 
### 4. 解锁能力 
稳定解锁：[Google](https://www.google.com)、[Youtube](https://www.youtube.com)、[维基百科](https://zh.wikipedia.org)、[Twitter（X）](https://x.com)  
无法解锁：[ChatGPT](https://chatgpt.com)、[Pixiv](https://pixiv.net) 
 
## 二、部署流程
### 1. 打开CF，新建pages
输入page名称
### 2. 上传_work.js
下载后记得修改uuid再上传
### 3. 完成部署
打开CF分配的网址https://你的网址/你修改后的uuid
即可访问控制面板，然后复制下载链接粘贴到Clash客户端
### 4. 完成！
