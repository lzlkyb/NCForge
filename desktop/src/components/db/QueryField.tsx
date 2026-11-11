import { useEffect, useRef } from "react";
import { useAppHidden } from "../../lib/appVisibility";
import { UI_FONT_FAMILY } from "../../lib/fonts";

/** Abstract query feedback; never draws over retained cells or intercepts grid input. */
export function QueryField({ host, state, previous, reduced = false }: {host:Element;state:string;previous:boolean;reduced?:boolean}) {
 const canvas=useRef<HTMLCanvasElement>(null);
 const hidden=useAppHidden();
 const observed=useRef(false);
 useEffect(()=>{
  const node=canvas.current,box=host as HTMLElement;
  const active=state==="running"||state==="cancelling";
  if(active)observed.current=true;
  if(hidden || state==="idle" || (!active && !observed.current))return;
  if(!node)return;
  if(!window.matchMedia || !window.ResizeObserver)return;
  const ctx=node.getContext("2d");if(!ctx)return;
  let frame=0,last=0,width=0,height=0,hover=false;
  const started=performance.now();
  const pointer={x:-1000,y:-1000};
  const media=window.matchMedia("(prefers-reduced-motion: reduce)");
  const resize=()=>{width=box.clientWidth;height=box.clientHeight;const scale=Math.min(devicePixelRatio,2);node.width=width*scale;node.height=height*scale;ctx.setTransform(scale,0,0,scale,0,0);};
  const observer=new ResizeObserver(resize);observer.observe(box);resize();
  box.dataset.queryField=active?(previous?"previous":"fresh"):"settled";
  box.dataset.queryOutcome=state;
  const move=(event:PointerEvent)=>{const rect=node.getBoundingClientRect();pointer.x=event.clientX-rect.left;pointer.y=event.clientY-rect.top;hover=true;};
  const leave=()=>{hover=false;pointer.x=-1000;};
  box.addEventListener("pointermove",move);box.addEventListener("pointerleave",leave);
  const draw=(now:number)=>{
   if(document.hidden)return;
   const quiet=reduced||media.matches;
   const age=(now-started)/1000;
   if(now-last>32||quiet){
    if(!box.getClientRects().length)return;
    last=now;ctx.clearRect(0,0,width,height);
    // Occupied cell bounds protect previous data. Only blank space or a narrow outer edge animates.
    let left=0;
    if(previous){const rect=node.getBoundingClientRect();const cells=[...box.querySelectorAll('[role="columnheader"]')];left=Math.max(0,...cells.map(cell=>cell.getBoundingClientRect().right-rect.left))+16;if(left>width-80)left=width-20;}
    const available=width-left;
    const teal=getComputedStyle(box).getPropertyValue("--primary").trim();
    const color=teal?`hsl(${teal})`:getComputedStyle(box).color;
    const fade=active?state==="cancelling"?.35:1:Math.max(0,1-age/.24);
    ctx.save();ctx.beginPath();ctx.rect(left,0,available,height);ctx.clip();
    ctx.globalAlpha=fade*(previous?(hover?.2:.65):.75);ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1;
    const time=quiet?1.8:age;
    const cycle=(Math.sin(time*.8-Math.PI/2)+1)/2;
    for(let i=0;i<132;i++){
     const col=i%12,row=Math.floor(i/12);
     const seed=Math.sin(i*37.17)*.5+.5;
     const gx=left+available*(.16+col/12*.68),gy=height*(.18+row/11*.58);
     const wave=Math.sin(time*.55+i*.41),drift=Math.cos(time*.43+i*.73);
     const gather=quiet?.75:cycle;
     let x=gx+wave*(1-gather)*available*.11,y=gy+drift*(1-gather)*height*.13;
     if(!quiet&&hover){const dx=x-pointer.x,dy=y-pointer.y,d=Math.hypot(dx,dy);if(d<70&&d>0){x+=dx/d*(70-d)*.22;y+=dy/d*(70-d)*.22;}}
     const length=2+gather*(10+seed*24);
     ctx.globalAlpha=fade*(previous?(hover?.15:.55):(.16+seed*.42));
     ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+length,y);ctx.stroke();
     if(i%7===0){ctx.beginPath();ctx.arc(x,y,1.5,0,Math.PI*2);ctx.fill();}
     if(i%12<11&&gather>.55){ctx.globalAlpha*=.22;ctx.beginPath();ctx.moveTo(x+length,y);ctx.lineTo(gx+available*.05,y);ctx.stroke();}
    }
    if(!previous&&active){ctx.globalAlpha=.78;ctx.fillStyle=getComputedStyle(box).color;ctx.font=`12px ${UI_FONT_FAMILY}`;ctx.textAlign="center";ctx.fillText(state==="cancelling"?"正在等待停止确认":"等待数据库返回",width/2,height*.83);}
    ctx.restore();
    if(!active && age>=.24)ctx.clearRect(0,0,width,height);
   }
   if((active&&!reduced&&!media.matches)||(!active&&age<.24))frame=requestAnimationFrame(draw);
  };
  const resume=()=>{cancelAnimationFrame(frame);if(!document.hidden)frame=requestAnimationFrame(draw);};
  const intersection=typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))resume();else cancelAnimationFrame(frame);}):null;
  intersection?.observe(box);
  document.addEventListener("visibilitychange",resume);media.addEventListener("change",resume);frame=requestAnimationFrame(draw);
  return()=>{cancelAnimationFrame(frame);observer.disconnect();intersection?.disconnect();box.removeEventListener("pointermove",move);box.removeEventListener("pointerleave",leave);document.removeEventListener("visibilitychange",resume);media.removeEventListener("change",resume);delete box.dataset.queryField;delete box.dataset.queryOutcome;};
 },[host,state,previous,reduced,hidden]);
 return <canvas className="dbx-query-field" ref={canvas} aria-hidden="true"/>;
}
