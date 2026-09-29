/* Pognali lightweight map engine — local WebView-safe Leaflet-compatible subset */
(function(){
'use strict';
const TILE=256,MAX_LAT=85.05112878,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function project(lat,lng,z){lat=clamp(+lat,-MAX_LAT,MAX_LAT);const n=2**z,r=lat*Math.PI/180;return{x:(+lng+180)/360*n*TILE,y:(1-Math.asinh(Math.tan(r))/Math.PI)/2*n*TILE}}
function unproject(x,y,z){const n=2**z,t=Math.PI*(1-2*y/TILE/n);return{lat:180/Math.PI*Math.atan(Math.sinh(t)),lng:x/TILE/n*360-180}}
function E(){this._ev={}} E.prototype.on=function(n,f){(this._ev[n]||(this._ev[n]=[])).push(f);return this};E.prototype.fire=function(n,d){(this._ev[n]||[]).slice().forEach(f=>{try{f(d||{})}catch(_){}});return this};
function MapLite(id){E.call(this);this._el=typeof id==='string'?document.getElementById(id):id;this._layers=[];this._tileLayer=null;this._center={lat:0,lng:0};this._zoom=2;this._removed=false;this._pointers=new Map();this._gesture='idle';this._pan=null;this._pinch=null;this._renderFrame=0;this._tileCache=new Map();if(!this._el)throw Error('Map container not found');this._el.classList.add('pognali-map');this._el.innerHTML='<div class="pm-tiles"></div><div class="pm-markers"></div><div class="pm-popup"></div><div class="pm-controls"><button type="button">+</button><button type="button">−</button></div><div class="pm-attrib">© OpenStreetMap contributors</div>';this._tilesEl=this._el.querySelector('.pm-tiles');this._markersEl=this._el.querySelector('.pm-markers');this._popupEl=this._el.querySelector('.pm-popup');this._el.querySelectorAll('.pm-controls button')[0].onclick=()=>this.setZoom(this._zoom+1,true);this._el.querySelectorAll('.pm-controls button')[1].onclick=()=>this.setZoom(this._zoom-1,true);this._bind();this._render()}
MapLite.prototype=Object.create(E.prototype);MapLite.prototype.constructor=MapLite;
MapLite.prototype.setView=function(ll,z){this._center={lat:+ll[0],lng:+ll[1]};this._zoom=clamp(Number.isFinite(+z)?+z:0,0,19);this._render();return this};
MapLite.prototype.getCenter=function(){return{lat:this._center.lat,lng:this._center.lng}};
MapLite.prototype.getZoom=function(){return this._zoom};
MapLite.prototype.setZoom=function(z,fire){const nz=clamp(+z,0,19);if(nz===this._zoom)return this;this._zoom=nz;this._render();if(fire){this.fire('zoomend');this.fire('moveend')}return this};
MapLite.prototype.panTo=function(ll){this._center={lat:+ll[0],lng:+ll[1]};this._render();this.fire('moveend');return this};
MapLite.prototype.invalidateSize=function(){this._render();return this};
MapLite.prototype.createPane=function(name){this._panes=this._panes||{};if(!this._panes[name])this._panes[name]={style:{},name};return this._panes[name]};
MapLite.prototype.getPane=function(name){return this._panes&&this._panes[name]||null};
MapLite.prototype._clearTiles=function(){this._tileCache.forEach(img=>{try{img.remove()}catch(_){}});this._tileCache.clear();};
MapLite.prototype.addLayer=function(l){if(l&&!this._layers.includes(l)){this._layers.push(l);l._map=this;l._addTo&&l._addTo(this)}return this};
MapLite.prototype.removeLayer=function(l){this._layers=this._layers.filter(x=>x!==l);l&&l._remove&&l._remove();this._render();return this};
MapLite.prototype.remove=function(){this._removed=true;if(this._renderFrame){cancelAnimationFrame(this._renderFrame);this._renderFrame=0}this._pointers.clear();this._layers.slice().forEach(l=>l._remove&&l._remove());this._layers=[];this._tileLayer=null;this._clearTiles();this._ev={};if(this._el)this._el.innerHTML='';return this};
MapLite.prototype._world=function(){return 2**this._zoom*TILE};
MapLite.prototype._screenCamera=function(){
  const w=this._world(),cw=this._el.clientWidth||360,ch=this._el.clientHeight||600;
  const c=project(this._center.lat,this._center.lng,this._zoom);
  return{w,cx:c.x,cy:c.y,halfW:cw/2,halfH:ch/2};
};
MapLite.prototype._screen=function(lat,lng){
  const cam=this._screenCamera(),p=project(lat,lng,this._zoom);
  let dx=p.x-cam.cx;if(dx>cam.w/2)dx-=cam.w;if(dx<-cam.w/2)dx+=cam.w;
  return{x:cam.halfW+dx,y:cam.halfH+p.y-cam.cy};
};
MapLite.prototype._screenFromCamera=function(lat,lng,cam){
  const p=project(lat,lng,this._zoom);
  let dx=p.x-cam.cx;if(dx>cam.w/2)dx-=cam.w;if(dx<-cam.w/2)dx+=cam.w;
  return{x:cam.halfW+dx,y:cam.halfH+p.y-cam.cy};
};
MapLite.prototype._fromScreen=function(x,y){const c=project(this._center.lat,this._center.lng,this._zoom),w=this._world();let wx=c.x+x-this._el.clientWidth/2,wy=c.y+y-this._el.clientHeight/2;wx=((wx%w)+w)%w;return unproject(wx,wy,this._zoom)};
MapLite.prototype._render=function(){if(this._removed)return;this._tiles();this._layers.forEach(l=>l&&l._render&&l._render())};
MapLite.prototype._scheduleRender=function(){if(this._removed||this._renderFrame)return;this._renderFrame=requestAnimationFrame(()=>{this._renderFrame=0;this._render()})};
MapLite.prototype._gestureTransform=function(tx,ty,scale){
  if(this._removed)return;
  const t='translate3d('+tx+'px,'+ty+'px,0)'+(scale===1?'':' scale('+scale+')');
  if(this._tilesEl)this._tilesEl.style.transform=t;
  if(this._markersEl)this._markersEl.style.transform=t;
};
MapLite.prototype._clearGestureTransform=function(){
  if(this._tilesEl)this._tilesEl.style.transform='';
  if(this._markersEl)this._markersEl.style.transform='';
};
MapLite.prototype._tiles=function(){
  const w=this._el.clientWidth||360,h=this._el.clientHeight||600,z=this._zoom,n=2**z,c=project(this._center.lat,this._center.lng,z);
  const layer=this._tileLayer,template=layer?.url||layer?._url||'https://tile.openstreetmap.org/{z}/{x}/{y}.png',subs=layer?.options?.subdomains||'abc';
  const subList=Array.isArray(subs)?subs:String(subs||'abc').split('');
  const x0=Math.floor((c.x-w/2)/TILE)-1,x1=Math.floor((c.x+w/2)/TILE)+1,y0=Math.floor((c.y-h/2)/TILE)-1,y1=Math.floor((c.y+h/2)/TILE)+1,needed=new Set();
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
    if(y<0||y>=n)continue;
    const xx=((x%n)+n)%n,key=template+'|'+z+'/'+xx+'/'+y;needed.add(key);
    let img=this._tileCache.get(key);
    if(!img){
      img=document.createElement('img');img.className='pm-tile';img.width=256;img.height=256;img.draggable=false;img.dataset.tileKey=key;
      let src=template.replace(/\{z\}/g,z).replace(/\{x\}/g,xx).replace(/\{y\}/g,y);
      src=src.replace(/\{s\}/g,subList[(Math.abs(x)+Math.abs(y))%Math.max(1,subList.length)]||'a').replace(/\{r\}/g,'');
      img.src=src;
      img.onerror=()=>{if(layer)layer.fire('tileerror',{tile:img,x:xx,y});};
      this._tileCache.set(key,img);this._tilesEl.appendChild(img);
    }
    const left=(this._el.clientWidth/2+x*TILE-c.x)+'px',top=(this._el.clientHeight/2+y*TILE-c.y)+'px';
    if(img.style.left!==left)img.style.left=left;
    if(img.style.top!==top)img.style.top=top;
    if(img.parentNode!==this._tilesEl)this._tilesEl.appendChild(img);
  }
  this._tileCache.forEach((img,key)=>{if(!needed.has(key)){img.remove();this._tileCache.delete(key)}});
};
MapLite.prototype._bind=function(){
const el=this._el;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const beginPan=(p)=>{this._gesture='pan';this._pan={id:p.id,x:p.x,y:p.y,cx:this._center.lng,cy:this._center.lat};this._pinch=null};
const beginPinch=()=>{
  const ps=[...this._pointers.values()];if(ps.length<2)return;
  const a=ps[0],b=ps[1],mid=midpoint(a,b),d=Math.max(1,distance(a,b));
  const r=el.getBoundingClientRect();
  this._gesture='pinch';this._pan=null;this._pinch={distance:d,mid,zoom:this._zoom,target:this._fromScreen(mid.x-r.left,mid.y-r.top)};this._gestureMoved=true;
};
el.addEventListener('pointerdown',e=>{
  if(e.target.closest('.pm-controls,.pm-marker,.pm-popup'))return;
  this._pointers.set(e.pointerId,{id:e.pointerId,x:e.clientX,y:e.clientY});
  try{el.setPointerCapture(e.pointerId)}catch(_){}
  if(this._pointers.size===1){this._gestureMoved=false;beginPan(this._pointers.get(e.pointerId))}
  else if(this._pointers.size===2)beginPinch();
  else this._gestureMoved=true;
});
el.addEventListener('pointermove',e=>{
  const p=this._pointers.get(e.pointerId);if(!p)return;
  p.x=e.clientX;p.y=e.clientY;
  const r=el.getBoundingClientRect();
  if(this._pointers.size>=2&&this._gesture==='pinch'){
    const ps=[...this._pointers.values()],a=ps[0],b=ps[1],mid=midpoint(a,b),d=Math.max(1,distance(a,b));
    const pinch=this._pinch;if(!pinch)return;
    if(d>pinch.distance*1.01||d<pinch.distance*.99)this._gestureMoved=true;
    const nz=clamp(pinch.zoom+Math.log2(d/pinch.distance),0,19);
    this._zoom=nz;
    const target=pinch.target,screenX=mid.x-r.left,screenY=mid.y-r.top;
    const tp=project(target.lat,target.lng,nz),w=this._world();
    let cx=tp.x-screenX+el.clientWidth/2,cy=tp.y-screenY+el.clientHeight/2;
    cx=((cx%w)+w)%w;
    this._center=unproject(cx,cy,nz);
    const baseScale=2**(this._zoom-pinch.zoom);
    const tx=screenX*(1-baseScale),ty=screenY*(1-baseScale);
    this._gestureTransform(tx,ty,baseScale);
    return;
  }
  if(this._pointers.size===1&&this._gesture==='pan'){
    const pan=this._pan;if(!pan)return;
    const dx=e.clientX-pan.x,dy=e.clientY-pan.y;
    if(Math.abs(dx)+Math.abs(dy)>4)this._gestureMoved=true;
    const p0=project(pan.cy,pan.cx,this._zoom);
    this._center=unproject(p0.x-dx,p0.y-dy,this._zoom);
    this._gestureTransform(dx,dy,1);
  }
});
el.addEventListener('pointerup',e=>{
  if(!this._pointers.has(e.pointerId))return;
  this._pointers.delete(e.pointerId);
  if(this._pointers.size>=2){beginPinch();return}
  if(this._pointers.size===1){
    const p=[...this._pointers.values()][0];
    if(this._gesture==='pinch')beginPan(p);
    return;
  }
  const wasMoved=this._gestureMoved,wasPan=this._gesture==='pan'||this._gesture==='pinch';
  this._gesture='idle';this._pan=null;this._pinch=null;
  if(wasPan){this._clearGestureTransform();this._render();this.fire('moveend');}
  if(!wasMoved){
    const r=el.getBoundingClientRect();
    this.fire('click',{latlng:this._fromScreen(e.clientX-r.left,e.clientY-r.top),originalEvent:e});
  }
});
el.addEventListener('pointercancel',e=>{
  if(this._pointers.has(e.pointerId))this._pointers.delete(e.pointerId);
  if(this._pointers.size===1){
    const p=[...this._pointers.values()][0];beginPan(p);return;
  }
  if(this._pointers.size===0){this._gesture='idle';this._pan=null;this._pinch=null;this._clearGestureTransform();this._render();this.fire('moveend')}
});
el.addEventListener('wheel',e=>{
  e.preventDefault();
  const r=el.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,target=this._fromScreen(x,y);
  const nz=clamp(this._zoom+(e.deltaY<0?1:-1),0,19);if(nz===this._zoom)return;
  this._zoom=nz;const tp=project(target.lat,target.lng,nz),w=this._world();
  let cx=tp.x-x+el.clientWidth/2,cy=tp.y-y+el.clientHeight/2;cx=((cx%w)+w)%w;this._center=unproject(cx,cy,nz);
  this._render();this.fire('zoomend');this.fire('moveend');
},{passive:false})};
MapLite.prototype.fitBounds=function(b,opts){if(!b||!Number.isFinite(b.minLat)||!Number.isFinite(b.maxLat)||!Number.isFinite(b.minLng)||!Number.isFinite(b.maxLng))return this;const maxZoom=Math.min(opts?.maxZoom??13,19),pad=opts?.padding||[0,0],availW=Math.max(100,this._el.clientWidth-(pad[1]||0)*2),availH=Math.max(100,this._el.clientHeight-(pad[0]||0)*2),lat=(b.minLat+b.maxLat)/2,lng=(b.minLng+b.maxLng)/2;let z=0;for(let zz=maxZoom;zz>=1;zz--){const a=project(b.maxLat,b.minLng,zz),c=project(b.minLat,b.maxLng,zz);if(Math.abs(c.x-a.x)<=availW&&Math.abs(c.y-a.y)<=availH){z=zz;break}}return this.setView([lat,lng],z)};
function TileLayer(u,o){E.call(this);this.url=u;this._url=u;this.options=o||{}}
TileLayer.prototype=Object.create(E.prototype);
TileLayer.prototype.addTo=function(m){m.addLayer(this);return this};
TileLayer.prototype._addTo=function(m){if(m._tileLayer&&m._tileLayer!==this)m._tileLayer._remove&&m._tileLayer._remove();m._tileLayer=this;m._clearTiles();m._render()};
TileLayer.prototype._remove=function(){if(this._map&&this._map._tileLayer===this){this._map._tileLayer=null;this._map._clearTiles()}};
function DivIcon(o){this.options=o||{}}
function CircleMarker(ll,o){E.call(this);this._lat=+ll[0];this._lng=+ll[1];this.options=o||{};this._map=null;this._icon=null;this._tooltip=''}
CircleMarker.prototype=Object.create(E.prototype);CircleMarker.prototype.constructor=CircleMarker;
CircleMarker.prototype.addTo=function(m){m.addLayer(this);return this};
CircleMarker.prototype._addTo=function(m){this._map=m;this._icon=document.createElement('div');this._icon.className='pm-user-location';this._icon.title=this._tooltip||'';m._markersEl.appendChild(this._icon);this._render()};
CircleMarker.prototype._render=function(){if(!this._icon||!this._map)return;const p=this._map._screen(this._lat,this._lng),r=+this.options.radius||8;this._icon.style.position='absolute';this._icon.style.width=(r*2)+'px';this._icon.style.height=(r*2)+'px';this._icon.style.left=(p.x-r)+'px';this._icon.style.top=(p.y-r)+'px';this._icon.style.zIndex=750;this._icon.style.border=(this.options.weight??3)+'px solid '+(this.options.color||'#fff');this._icon.style.background=this.options.fillColor||'#2477ff';this._icon.style.borderRadius='50%';this._icon.style.boxSizing='border-box';this._icon.style.opacity=this.options.fillOpacity??1};
CircleMarker.prototype.setLatLng=function(ll){this._lat=+ll[0];this._lng=+ll[1];this._render();return this};
CircleMarker.prototype.getLatLng=function(){return{lat:this._lat,lng:this._lng}};
CircleMarker.prototype.bindTooltip=function(text){this._tooltip=String(text||'');if(this._icon)this._icon.title=this._tooltip;return this};
CircleMarker.prototype.remove=function(){if(this._map)this._map.removeLayer(this);return this};
CircleMarker.prototype._remove=function(){this._icon?.remove();this._icon=null;this._map=null};
function Marker(ll,o){E.call(this);this._lat=+ll[0];this._lng=+ll[1];this.options=o||{};this._map=null;this._icon=null;this._popup=null;this._dragging=false}
Marker.prototype=Object.create(E.prototype);Marker.prototype.addTo=function(m){m.addLayer(this);return this};Marker.prototype._addTo=function(m){this._map=m;const o=this.options.icon?.options||{};this._icon=document.createElement('div');this._icon.className='pm-marker '+(o.className||'');this._icon.innerHTML=o.html||'📍';this._icon.style.width=(o.iconSize?.[0]||42)+'px';this._icon.style.height=(o.iconSize?.[1]||42)+'px';this._icon.style.touchAction=this.options.draggable?'none':'manipulation';m._markersEl.appendChild(this._icon);if(this.options.draggable){this._icon.addEventListener('pointerdown',e=>{e.stopPropagation();this._dragging=true;try{this._icon.setPointerCapture(e.pointerId)}catch(_){} });this._icon.addEventListener('pointermove',e=>{if(!this._dragging)return;const r=m._el.getBoundingClientRect(),p=m._fromScreen(e.clientX-r.left,e.clientY-r.top);this._lat=p.lat;this._lng=p.lng;this._render()});this._icon.addEventListener('pointerup',e=>{e.stopPropagation();if(this._dragging){this._dragging=false;this.fire('dragend')}})}this._icon.addEventListener('click',e=>{e.stopPropagation();if(!this._dragging)this.fire('click',{originalEvent:e})});this.on('click',()=>this.openPopup());this._render()};
Marker.prototype._render=function(){if(!this._icon||!this._map)return;const p=this._map._screen(this._lat,this._lng),o=this.options.icon?.options||{},w=o.iconSize?.[0]||42,h=o.iconSize?.[1]||42,ax=o.iconAnchor?.[0]??w/2,ay=o.iconAnchor?.[1]??h/2;const margin=80,display=(p.x>-margin&&p.x<this._map._el.clientWidth+margin&&p.y>-margin&&p.y<this._map._el.clientHeight+margin)?'grid':'none',left=(p.x-ax)+'px',top=(p.y-ay)+'px';if(this._icon.style.display!==display)this._icon.style.display=display;if(this._icon.style.position!=='absolute')this._icon.style.position='absolute';if(this._icon.style.left!==left)this._icon.style.left=left;if(this._icon.style.top!==top)this._icon.style.top=top;if(this._icon.style.zIndex!=='600')this._icon.style.zIndex=600};
Marker.prototype.setLatLng=function(ll){this._lat=+ll[0];this._lng=+ll[1];this._render();return this};Marker.prototype.getLatLng=function(){return{lat:this._lat,lng:this._lng}};Marker.prototype.bindPopup=function(h){this._popup=String(h);return this};Marker.prototype.openPopup=function(){if(this._map&&this._popup){this._map._popupEl.innerHTML=this._popup;this._map._popupEl.style.display='block';this._map._popupEl.style.left='50%';this._map._popupEl.style.bottom='74px';this._map._popupEl.style.transform='translateX(-50%)'}return this};Marker.prototype.remove=function(){if(this._map)this._map.removeLayer(this);return this};Marker.prototype._remove=function(){this._icon?.remove();this._icon=null;this._map=null};
function latLngBounds(ps){const a=ps||[],lat=a.map(p=>+p[0]).filter(Number.isFinite),lng=a.map(p=>+p[1]).filter(Number.isFinite);return{minLat:Math.min(...lat),maxLat:Math.max(...lat),minLng:Math.min(...lng),maxLng:Math.max(...lng)}}
window.L={map:(id)=>new MapLite(id),tileLayer:(u,o)=>new TileLayer(u,o),marker:(ll,o)=>new Marker(ll,o),circleMarker:(ll,o)=>new CircleMarker(ll,o),divIcon:o=>new DivIcon(o),latLngBounds};
const st=document.createElement('style');st.textContent='.pognali-map{position:relative;overflow:hidden;background:#dfe4e8;touch-action:none;-webkit-user-select:none;user-select:none}.pognali-map .pm-tiles,.pognali-map .pm-markers{position:absolute;inset:0;overflow:hidden}.pognali-map .pm-tile{position:absolute;display:block;max-width:none!important;max-height:none!important;width:256px;height:256px;padding:0;margin:0}.pognali-map .pm-marker{display:grid;place-items:center;position:absolute;pointer-events:auto}.pognali-map .pm-user-location{pointer-events:auto;filter:drop-shadow(0 2px 4px #0004)}.pognali-map .pm-controls{position:absolute;z-index:900;left:10px;top:56px;background:#fff;border-radius:10px;box-shadow:0 2px 10px #0003;overflow:hidden}.pognali-map .pm-controls button{display:block;width:40px;height:40px;background:#fff;border:0;border-bottom:1px solid #eee;font-size:25px;line-height:1}.pognali-map .pm-controls button:last-child{border-bottom:0}.pognali-map .pm-attrib{position:absolute;z-index:900;right:0;bottom:0;background:#ffffffcc;color:#555;font:10px/1.2 system-ui;padding:2px 5px}.pognali-map .pm-popup{display:none;position:absolute;z-index:1200;max-width:calc(100% - 24px);background:#fff;border-radius:14px;box-shadow:0 8px 24px #0004;padding:10px;pointer-events:auto}';document.head.appendChild(st);
})();