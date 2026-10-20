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
  if(document.querySelector('#diagram-viewer').open)return;
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

// Local vector viewer: no external page or runtime renderer is needed.
const viewer=document.querySelector('#diagram-viewer');
const viewport=document.querySelector('#viewer-viewport');
const diagramImage=document.querySelector('#viewer-image');
const zoomLabel=document.querySelector('#zoom-level');
let zoom=1, diagramWidth=1, diagramHeight=1, returnFocus=null, fitMode='all';
const pointers=new Map();
function renderZoom(value,anchor){
  const previous=zoom;
  zoom=Math.max(.03,Math.min(6,value));
  const bounds=viewport.getBoundingClientRect();
  const x=anchor?.x??bounds.width/2, y=anchor?.y??bounds.height/2;
  const px=(viewport.scrollLeft+x)/previous,py=(viewport.scrollTop+y)/previous;
  diagramImage.style.width=(diagramWidth*zoom)+'px';
  diagramImage.style.height=(diagramHeight*zoom)+'px';
  document.querySelector('#viewer-canvas').style.width=(diagramWidth*zoom+48)+'px';
  document.querySelector('#viewer-canvas').style.height=(diagramHeight*zoom+48)+'px';
  viewport.scrollLeft=px*zoom-x;viewport.scrollTop=py*zoom-y;
  zoomLabel.textContent=Math.round(zoom*100)+' %';
  document.querySelector('#zoom-out').disabled=zoom<=.03;
  document.querySelector('#zoom-in').disabled=zoom>=6;
}
function fitDiagram(mode='all'){
  fitMode=mode;
  const w=Math.max(80,viewport.clientWidth-52),h=Math.max(80,viewport.clientHeight-52);
  renderZoom(mode==='width'?w/diagramWidth:Math.min(w/diagramWidth,h/diagramHeight));
  viewport.scrollLeft=0;viewport.scrollTop=0;
}
document.querySelectorAll('[data-diagram]').forEach(button=>button.addEventListener('click',()=>{
  returnFocus=button;
  document.querySelector('#viewer-title').textContent=button.dataset.diagramTitle;
  const src='assets/'+button.dataset.diagram+'.svg';
  document.querySelector('#download-diagram').href=src;
  diagramImage.alt=button.dataset.diagramTitle;
  document.querySelector('#viewer-error').hidden=true;
  diagramImage.hidden=true;
  viewer.showModal();
  diagramImage.onload=()=>{diagramWidth=diagramImage.naturalWidth;diagramHeight=diagramImage.naturalHeight;diagramImage.hidden=false;fitDiagram(button.dataset.diagram==='secuencia-apuesta'?'width':'all');};
  diagramImage.onerror=()=>{document.querySelector('#viewer-error').hidden=false;};
  diagramImage.src=src;
}));
document.querySelector('#viewer-close').addEventListener('click',()=>viewer.close());
viewer.addEventListener('close',()=>{pointers.clear();viewport.classList.remove('dragging');returnFocus?.focus();});
document.querySelector('#zoom-in').addEventListener('click',()=>{fitMode=null;renderZoom(zoom*1.3);});
document.querySelector('#zoom-out').addEventListener('click',()=>{fitMode=null;renderZoom(zoom/1.3);});
document.querySelector('#zoom-fit').addEventListener('click',()=>fitDiagram('all'));
document.querySelector('#zoom-width').addEventListener('click',()=>fitDiagram('width'));
viewport.addEventListener('wheel',e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();fitMode=null;const r=viewport.getBoundingClientRect();renderZoom(zoom*(e.deltaY<0?1.12:1/1.12),{x:e.clientX-r.left,y:e.clientY-r.top});},{passive:false});
viewport.addEventListener('pointerdown',e=>{if(e.button!==0)return;viewport.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});viewport.classList.add('dragging');});
viewport.addEventListener('pointermove',e=>{
  const previous=pointers.get(e.pointerId);if(!previous)return;
  if(pointers.size===2){
    const other=[...pointers.entries()].find(([id])=>id!==e.pointerId)[1];
    const oldDistance=Math.hypot(previous.x-other.x,previous.y-other.y);
    const distance=Math.hypot(e.clientX-other.x,e.clientY-other.y);
    if(oldDistance>0){fitMode=null;const r=viewport.getBoundingClientRect();renderZoom(zoom*distance/oldDistance,{x:(e.clientX+other.x)/2-r.left,y:(e.clientY+other.y)/2-r.top});}
  }else{viewport.scrollLeft-=e.clientX-previous.x;viewport.scrollTop-=e.clientY-previous.y;}
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(event,e=>{pointers.delete(e.pointerId);if(!pointers.size)viewport.classList.remove('dragging');});
viewer.addEventListener('keydown',e=>{
  if(['+','=','-','0','arrowleft','arrowright','arrowup','arrowdown'].includes(e.key.toLowerCase())){
    e.preventDefault();e.stopPropagation();
    if(e.key==='+'||e.key==='='){fitMode=null;renderZoom(zoom*1.3);}
    if(e.key==='-'){fitMode=null;renderZoom(zoom/1.3);}
    if(e.key==='0')fitDiagram();
    if(e.key==='ArrowLeft')viewport.scrollLeft-=100;if(e.key==='ArrowRight')viewport.scrollLeft+=100;
    if(e.key==='ArrowUp')viewport.scrollTop-=100;if(e.key==='ArrowDown')viewport.scrollTop+=100;
  }
});
window.addEventListener('resize',()=>{if(viewer.open&&fitMode)fitDiagram(fitMode);});
