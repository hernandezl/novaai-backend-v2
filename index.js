(() => {
  const $ = (s, c=document)=>c.querySelector(s);
  const $$ = (s, c=document)=>Array.from(c.querySelectorAll(s));
  const onReady=f=>document.readyState!=='loading'?f():document.addEventListener('DOMContentLoaded',f);
  const PRODUCT_KEY='negunova:selectedProduct';
  const saveP=p=>sessionStorage.setItem(PRODUCT_KEY,JSON.stringify(p||{}));
  const loadP=()=>JSON.parse(sessionStorage.getItem(PRODUCT_KEY)||'{}');

  const mountBadge=()=>{const b=document.createElement('div');b.id='proxy-badge';b.style.cssText='position:fixed;top:10px;left:10px;padding:6px 8px;background:#222;color:#fff;border-radius:8px;font:12px system-ui;z-index:9999';b.textContent='Proxy…';document.body.appendChild(b);return b;};
  const checkBadge=async(b)=>{try{const r=await fetch('/proxy.php?action=health');const d=await r.json();if(d.ok){b.textContent='Proxy OK (PHP '+d.php+')';b.style.background='#157347';}else throw 0;}catch{b.textContent='Proxy error';b.style.background='#b02a37';}};

  const NovaAI=(()=>{
    const getP=()=>window.selectedProduct||loadP()||{};
    const build=()=>{const p=getP();const c=($('#color')?.value||'').trim(),t1=($('#text1')?.value||'').trim(),t2=($('#text2')?.value||'').trim();const a=[];if(p.name)a.push(`Product mockup for laser/acrylic: ${p.name}`);if(c)a.push(`color: ${c}`);if(t1||t2)a.push(`text: \"${t1} ${t2}\"`);return a.join('. ')||'Product mockup';};
    const gen=async()=>{
      const os=$('#owner-status'),cs=$('#customer-status'),or=$('#result-owner'),cr=$('#result-customer');
      if(or)or.innerHTML='';if(cr)cr.innerHTML='';if(os)os.textContent='Owner omitted';if(cs)cs.textContent='Generating…';
      const prompt=($('#prompt')?.value||'').trim()||build();
      try{
        const r=await fetch('/proxy.php?action=image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-1',prompt,product:getP()})});
        const d=await r.json();if(!r.ok)throw new Error(d?.error?.message||r.status);
        const b64=d?.data?.[0]?.b64_json,url=d?.data?.[0]?.url;
        if(cr){if(b64){const i=new Image();i.src='data:image/png;base64,'+b64;cr.replaceChildren(i);}else if(url){cr.innerHTML='<img src=\"'+url+'\">';}}
        if(cs)cs.textContent='Done';
      }catch(e){console.error(e);if(cs)cs.textContent='Error: '+e.message;}
    };
    return{gen};
  })();

  const initNova=()=>{const b=mountBadge();checkBadge(b);const btn=$('#btn-generate');if(btn)btn.onclick=e=>{e.preventDefault();NovaAI.gen();};};
  onReady(()=>{if(/novaai\\.html$/i.test(location.pathname))initNova();});
})();
