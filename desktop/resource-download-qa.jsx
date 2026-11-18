
import React from 'react';
import {createRoot} from 'react-dom/client';
// 临时验收入口不得引入新预打包依赖，否则加载中的 React 图会失效并产生双实例。
import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
import {emit} from '/node_modules/@tauri-apps/api/event.js';
mockWindows('main');window.resourceCalls=[];
window.resourcePacks=[['jdtls','Java 代码智能'],['ecj','Java 编译器'],['svnkit','SVN 版本控制'],['cfr','CFR 反编译']].map(([id,title])=>({id,title,notes:'对应功能按需下载，完成后保存在本机',state:'missing',version:null,size:null}));
mockIPC(async(cmd,args)=>{
 if(cmd==='resources_status')return window.resourcePacks;
 if(cmd==='resources_ensure'){window.resourceCalls.push(args);return null;}
 if(cmd.startsWith('plugin:'))return cmd==='plugin:window|is_visible'?true:null;
 return null;
},{shouldMockEvents:true});
window.resourceEmit=async(name,payload)=>{
 if(name==='resource:installed')window.resourcePacks=window.resourcePacks.map(p=>p.id===payload.id?{...p,state:'installed',version:payload.version,size:1048576}:p);
 await emit(name,payload);
};
await import('/src/index.css');
const appearance=await import('/src/lib/appearance.ts');appearance.applyAppearance('glass');
const theme=await import('/src/lib/theme.ts');window.resourceTheme=theme.applyTheme;
const {ResourceProvider}=await import('/src/contexts/ResourceContext.tsx');
const {ResourceSettings}=await import('/src/components/settings/ResourceSettings.tsx');
const {ResourceDownloadEntry}=await import('/src/components/resource/ResourceDownloadEntry.tsx');
const {ResourceDownloadButton}=await import('/src/components/resource/ResourceDownloadButton.tsx');
createRoot(document.getElementById('root')).render(React.createElement(ResourceProvider,null,
 React.createElement('header',{className:'app-header flex items-center justify-end p-2'},React.createElement(ResourceDownloadEntry)),
 React.createElement('main',{style:{maxWidth:800,margin:'24px auto',padding:20}},
 React.createElement(ResourceSettings),React.createElement('div',{style:{marginTop:20}},React.createElement(ResourceDownloadButton,{id:'svnkit'})))));
