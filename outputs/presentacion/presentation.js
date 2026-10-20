'use strict';
const slides = [...document.querySelectorAll('.slide')];
const deck = document.querySelector('#deck');
const notesData = JSON.parse(document.querySelector('#notes-data').textContent);
const notes = document.querySelector('#notes');
const indexPanel = document.querySelector('#slide-index');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const mobile = window.matchMedia('(max-width:700px)');
let current = -1;
window.__timelines = window.__timelines || {};
// Build every entrance synchronously. Navigation owns playback in the web deck.
const entries = slides.map((slide,i) => {
  if (!window.gsap) return null;
  const tl = gsap.timeline({paused:true,onComplete:()=>{slides.forEach((s,j)=>{if(j!==current)s.hidden=true;});}});
  tl.from(slide,{opacity:0,duration:.3,ease:'power2.out',immediateRender:false},0);
  const title=slide.querySelector('h2,h1');
  if(title) tl.from(title,{y:14,opacity:0,duration:.42,ease:'power3.out',immediateRender:false},.08);
  const body=slide.querySelector('.slide-body');
  tl.from(body,{opacity:0,duration:.35,ease:'power2.out',immediateRender:false},.12);
  const visual=slide.querySelector('.diagram,.brief,.adr,.flow,.idem,.peak-actions');
  if(visual) tl.from(visual,{y:10,duration:.45,ease:'expo.out',immediateRender:false},.15);
  window.__timelines['slide-'+(i+1)] = tl;
  return tl;
});

function fit(){
  if(mobile.matches){document.documentElement.style.setProperty('--stage-scale',1);return;}
  const main=document.querySelector('main');
  const scale=Math.min(main.clientWidth/1600,main.clientHeight/900);
  document.documentElement.style.setProperty('--stage-scale',scale);
  const shell=document.querySelector('#stage-shell');
  shell.style.width=1600*scale+'px';shell.style.height=900*scale+'px';
}
function showSlide(n,writeHash=true){
  n=Math.max(0,Math.min(slides.length-1,n));
  const previous=current;
  if(current===n)return;
  slides.forEach((s,i)=>{s.hidden=i!==n;s.inert=i!==n;if(i!==n)entries[i]?.pause(0);});
  current=n;
  const next=slides[current];next.hidden=false;next.inert=false;
  slides.forEach(s=>s.style.zIndex='0');next.style.zIndex='2';
  if(previous>=0&&!reducedMotion.matches&&entries[current]){slides[previous].hidden=false;slides[previous].style.zIndex='1';}
  if(!reducedMotion.matches)entries[current]?.restart();else entries[current]?.progress(1).pause();
  document.querySelector('#counter').textContent=String(n+1).padStart(2,'0')+' / 20';
  document.querySelector('#progress-fill').style.transform='scaleX('+((n+1)/slides.length)+')';
  document.querySelector('#prev').disabled=n===0;document.querySelector('#next').disabled=n===slides.length-1;
  document.querySelector('#notes-content').innerHTML=notesData[n];
  document.querySelector('#section-name').textContent=n<5?'Arquitectura':n<12?'Comunicación y datos':n<15?'Operación':n<18?'Decisiones registradas':'Evolución y cierre';
  document.querySelectorAll('[data-slide]').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.slide)===n)));
  if(writeHash)history.replaceState(null,'','#'+(n+1));
  document.querySelector('main').scrollTop=0;
}
function togglePanel(panel,toggle,force){
  const open=force??panel.hidden;
  if(open){const other=panel===notes?indexPanel:notes;other.hidden=true;document.querySelector(other===notes?'#notes-toggle':'#index-toggle').setAttribute('aria-expanded','false');}
  panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));
  if(open)panel.querySelector('button').focus();else toggle.focus();
}
document.querySelector('#prev').addEventListener('click',()=>showSlide(current-1));
document.querySelector('#next').addEventListener('click',()=>showSlide(current+1));
document.querySelector('#index-toggle').addEventListener('click',()=>togglePanel(indexPanel,document.querySelector('#index-toggle')));
document.querySelector('#notes-toggle').addEventListener('click',()=>togglePanel(notes,document.querySelector('#notes-toggle')));
document.querySelector('#index-close').addEventListener('click',()=>togglePanel(indexPanel,document.querySelector('#index-toggle'),false));
document.querySelector('#notes-close').addEventListener('click',()=>togglePanel(notes,document.querySelector('#notes-toggle'),false));
document.querySelectorAll('[data-slide]').forEach(b=>b.addEventListener('click',()=>{showSlide(Number(b.dataset.slide));togglePanel(indexPanel,document.querySelector('#index-toggle'),false);}));
async function fullScreen(){
  const control=document.querySelector('#fullscreen');
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{control.textContent='Usa la pantalla completa del navegador';}
}
document.querySelector('#fullscreen').addEventListener('click',fullScreen);
document.addEventListener('fullscreenchange',()=>{document.querySelector('#fullscreen').innerHTML=(document.fullscreenElement?'Salir de pantalla completa':'Pantalla completa')+' <kbd>F</kbd>';fit();});
document.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.metaKey||e.altKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  const k=e.key.toLowerCase();
  if(k==='escape'){if(!notes.hidden)togglePanel(notes,document.querySelector('#notes-toggle'),false);if(!indexPanel.hidden)togglePanel(indexPanel,document.querySelector('#index-toggle'),false);return;}
  if(k==='i'){e.preventDefault();togglePanel(indexPanel,document.querySelector('#index-toggle'));return;}
  if(k==='n'){e.preventDefault();togglePanel(notes,document.querySelector('#notes-toggle'));return;}
  if(!notes.hidden||!indexPanel.hidden)return;
  if(k==='f'){e.preventDefault();fullScreen();}
  if(['arrowright','pagedown',' '].includes(k)&&!(k===' '&&e.target.closest('button'))){e.preventDefault();showSlide(current+1);}
  if(['arrowleft','pageup'].includes(k)){e.preventDefault();showSlide(current-1);}
  if(k==='home'){e.preventDefault();showSlide(0);}if(k==='end'){e.preventDefault();showSlide(slides.length-1);}
});
window.addEventListener('resize',fit);
window.addEventListener('hashchange',()=>showSlide((parseInt(location.hash.slice(1))||1)-1,false));
showSlide((parseInt(location.hash.slice(1))||1)-1);fit();

document.querySelectorAll('table').forEach(table=>{const labels=[...table.querySelectorAll('th')].map(t=>t.textContent);table.querySelectorAll('tbody tr').forEach(row=>[...row.children].forEach((td,i)=>td.dataset.label=labels[i]||''));});

// HyperFrames seeking follows the same slides as keyboard navigation.
if (window.gsap) {
  const playback = gsap.timeline({paused:true,onUpdate:function(){
    const n=Math.min(slides.length-1,Math.floor(this.time()/10));
    showSlide(n,false);
    entries[n]?.progress(1).pause();
  }});
  playback.fromTo('#progress-fill',{scaleX:.05},{scaleX:1,duration:200,ease:'none',immediateRender:false});
  window.__timelines['medianos-eia']=playback;
}
