(() => {
  'use strict';

  const DB_NAME = 'TwitterDBCache';
  const STORE_NAME = 'data';
  const CACHE_KEY = 'compactTweets';
  const VERSION_KEY = 'sourceVersion';
  const status = document.getElementById('rangeLabel');
  const privateData = window.PrivateTwitterDB;

  function setStatus(message) { if (status) status.textContent = message; }
  function loadScript(src) { return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error(`${src}の読み込みに失敗しました`));document.head.appendChild(script)}); }
  function openDatabase() { return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE_NAME))db.createObjectStore(STORE_NAME)};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)}); }
  function readCache(db,key) { return new Promise((resolve,reject)=>{const request=db.transaction(STORE_NAME,'readonly').objectStore(STORE_NAME).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)}); }
  function writeCache(db,values) { return new Promise((resolve,reject)=>{const transaction=db.transaction(STORE_NAME,'readwrite');const store=transaction.objectStore(STORE_NAME);for(const [key,value] of Object.entries(values))store.put(value,key);transaction.oncomplete=resolve;transaction.onerror=()=>reject(transaction.error)}); }

  async function gunzipBase64(encoded) {
    const compressed=Uint8Array.from(atob(encoded),(char)=>char.charCodeAt(0));
    const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function loadCategories(token) {
    const encoded=await privateData.assignment('analytics/categories.js',token);
    const payload=await gunzipBase64(encoded);
    const categories=new Map(payload.rows.map(([id,subject,topic,postStyle])=>[String(id),{subject:payload.subjects[subject],topic:payload.topics[topic],postStyle:payload.postStyles[postStyle]}]));
    const saved=await privateData.json('analytics/corrections.json',token);
    for(const item of saved.corrections||[]){const current=categories.get(String(item.tweetId))||{};categories.set(String(item.tweetId),{subject:item.subject||current.subject||'未分類',topic:item.topic||current.topic||'未分類',postStyle:item.postStyle||current.postStyle||'未分類'})}
    window.TwitterDBCategories=categories;
  }

  function compactArchive(rows) {
    const byId=new Map();
    for(const row of rows){
      const tweet=row?.tweet||row||{}; const text=tweet.full_text||tweet.text||''; const id=String(tweet.id_str||tweet.id||''); if(!id||!text)continue;
      byId.set(id,{i:id,x:text,d:tweet.created_at||'',l:Number(tweet.favorite_count||0),r:Number(tweet.retweet_count||0),p:tweet.in_reply_to_screen_name||'',t:Boolean(tweet.retweeted_status||/^RT\s+@/i.test(text)),q:Boolean(tweet.quoted_status_id_str||tweet.quoted_status_id||tweet.is_quote_status===true||tweet.is_quote_status==='true'),y:Boolean(tweet.in_reply_to_status_id_str||tweet.in_reply_to_status_id||tweet.in_reply_to_user_id_str||tweet.in_reply_to_screen_name||/^@[A-Za-z0-9_]{1,15}\b/.test(text))});
    }
    return [...byId.values()];
  }

  function exposeForExistingApp(compact) {
    window.YTD={tweets:{cached:compact.map((item)=>({tweet:{id_str:item.i,full_text:item.x,created_at:item.d,favorite_count:item.l,retweet_count:item.r,in_reply_to_screen_name:item.p,retweeted_status:item.t?{}:undefined,quoted_status_id_str:item.q?'1':undefined,in_reply_to_status_id_str:item.y?'1':undefined}}))}};
  }

  async function loadApp(){ await loadScript('./app-v9.js?v=21'); }

  async function showUnlock(message) {
    window.YTD={tweets:{}};
    window.TwitterDBCategories=new Map();
    await loadApp();
    document.getElementById('syncSettings')?.click();
    const box=document.getElementById('syncMessage');
    if(box)box.textContent=message;
  }

  async function start(){
    if(!privateData)throw new Error('非公開データ接続を初期化できませんでした。');
    const token=privateData.getToken();
    if(!token){await showUnlock('非公開の投稿データを表示するには、GitHubトークンを設定してください。');return}
    let version='';
    try{
      version=await privateData.version(token);
      await loadCategories(token);
    }catch(error){await showUnlock(`非公開データへ接続できませんでした：${error.message}`);return}

    let db=null;
    try{
      db=await openDatabase();
      const [cachedVersion,cachedTweets]=await Promise.all([readCache(db,VERSION_KEY),readCache(db,CACHE_KEY)]);
      if(Array.isArray(cachedTweets)&&cachedTweets.length&&cachedVersion===version){
        setStatus('保存済みデータを読み込んでいます…');
        exposeForExistingApp(cachedTweets);
        await loadApp();
        return;
      }
    }catch{db=null}

    try{
      setStatus('非公開の投稿データを読み込んでいます…');
      const rows=await privateData.archive(token);
      const compact=compactArchive(rows);
      exposeForExistingApp(compact);
      if(db){try{await writeCache(db,{[CACHE_KEY]:compact,[VERSION_KEY]:version})}catch{}}
      await loadApp();
    }catch(error){await showUnlock(`投稿データを読み込めませんでした：${error.message}`)}
  }

  start().catch((error)=>{setStatus(`データの読み込みに失敗しました：${error.message}`);const box=document.getElementById('status');if(box){box.hidden=false;box.textContent=error.message}});
})();
