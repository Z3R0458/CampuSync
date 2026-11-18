import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { friendlyError, useFeedback } from '../components/UserFeedback'

const bucket = 'school-announcements'
const categories = [
  ['general','General announcement'],['academic','Academic'],['enrollment','Enrollment'],['events','School events'],
  ['examination','Examination'],['schedule_changes','Schedule changes'],['emergency','Emergency notices'],['other','Other'],
] as const
const priorities = [['normal','Normal'],['important','Important'],['urgent','Urgent'],['emergency','Emergency']] as const
const audiences = [['all','Everyone'],['student','Students only'],['teacher','Teachers only'],['guard','Guards only']] as const
type Status = 'draft'|'scheduled'|'published'|'unpublished'|'archived'
type Attachment = { name:string; path:string; mime_type:string; size:number }
type Announcement = {
  id:string; title:string; summary:string|null; body:string; audience:string; category:string; priority:string
  status:Status; content_format:'text'|'html'; published_at:string|null; expires_at:string|null
  target_grade_level:string|null; target_section_id:string|null; attachments:Attachment[]
  created_by:string|null; last_modified_by:string|null; created_at:string; updated_at:string
}
type Section = {id:string;name:string;grade_level:string}
type Props = {profileId:string}
const dateTime = (value:string|null) => value ? new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '—'
const localInput = (value:string|null) => value ? new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Manila'}).replace(' ','T').slice(0,16) : ''
const plainText = (html:string) => {
  const element=document.createElement('div');element.innerHTML=DOMPurify.sanitize(html);return (element.textContent??'').replace(/\s+/g,' ').trim()
}
const priorityColor:Record<string,string> = {normal:'bg-slate-100 text-slate-700',important:'bg-blue-100 text-blue-800',urgent:'bg-amber-100 text-amber-900',emergency:'bg-rose-100 text-rose-800'}

function SafeContent({item}:{item:Pick<Announcement,'body'|'content_format'>}) {
  if(item.content_format==='html') return <div className="announcement-content" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(item.body)}} />
  return <p className="whitespace-pre-wrap">{item.body}</p>
}

function SignedAttachments({items}:{items:Attachment[]}) {
  const [urls,setUrls]=useState<Record<string,string>>({})
  const [error,setError]=useState('')
  useEffect(()=>{let active=true;void(async()=>{if(!supabase||!items.length)return;const found:Record<string,string>={};for(const item of items){const {data,error:storageError}=await supabase.storage.from(bucket).createSignedUrl(item.path,3600);if(storageError){if(active)setError(friendlyError(storageError));continue}if(data)found[item.path]=data.signedUrl}if(active)setUrls(found)})();return()=>{active=false}},[items])
  if(!items.length)return null
  return <div className="mt-4 space-y-2">{items.map((item)=><div key={item.path} className="flex items-center gap-3 rounded-xl border border-slate-200 p-2.5 text-sm"><span className="min-w-0 flex-1 truncate">📎 {item.name}</span>{urls[item.path]&&<><a href={urls[item.path]} target="_blank" rel="noreferrer" className="font-semibold text-emerald-800">Open</a><a href={urls[item.path]} download={item.name} className="font-semibold text-emerald-800">Download</a></>}</div>)}{error&&<p role="status" className="text-xs text-amber-700">Attachment link unavailable: {error}</p>}</div>
}

export function AnnouncementFeed({items}:{items:Record<string,unknown>[]}) {
  const [selected,setSelected]=useState<Announcement|null>(null)
  const safeItems=items as unknown as Announcement[]
  return <>
    <div className="space-y-3">{safeItems.map((item)=><article key={item.id} className={`rounded-2xl border p-4 ${item.priority==='emergency'?'border-rose-300 bg-rose-50':item.priority==='urgent'?'border-amber-200 bg-amber-50':'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2"><div className="flex flex-wrap gap-2"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase">{categoryLabel(item.category)}</span><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${priorityColor[item.priority]??priorityColor.normal}`}>{item.priority}</span></div><time className="text-xs text-slate-500">{dateTime(item.published_at??item.created_at)}</time></div>
      <h4 className="mt-3 text-base font-bold">{item.title}</h4><p className="mt-1 text-sm text-slate-600">{item.summary||plainText(item.body).slice(0,180)}</p>{item.attachments?.length>0&&<p className="mt-2 text-xs text-slate-500">📎 {item.attachments.length} attachment{item.attachments.length===1?'':'s'}</p>}<button onClick={()=>setSelected(item)} className="mt-3 text-sm font-bold text-emerald-800">Read more →</button>
    </article>)}{!safeItems.length&&<p className="text-sm text-slate-500">No announcements published.</p>}</div>
    {selected&&<div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4" onClick={()=>setSelected(null)}><article role="dialog" aria-modal="true" aria-label={selected.title} onClick={(e)=>e.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl"><div className="flex justify-between gap-3"><div><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${priorityColor[selected.priority]??priorityColor.normal}`}>{selected.priority}</span><h2 className="mt-3 text-2xl font-bold">{selected.title}</h2></div><button onClick={()=>setSelected(null)} className="h-fit rounded-lg border px-3 py-1.5">Close</button></div>{selected.summary&&<p className="mt-3 text-slate-600">{selected.summary}</p>}<div className="mt-5"><SafeContent item={selected}/></div><SignedAttachments items={selected.attachments??[]}/><time className="mt-5 block text-xs text-slate-500">Published {dateTime(selected.published_at)}</time></article></div>}
  </>
}

export function AnnouncementManagement({profileId}:Props) {
  const { confirmAction } = useFeedback()
  const [rows,setRows]=useState<Announcement[]>([])
  const [sections,setSections]=useState<Section[]>([])
  const [createdByNames,setCreatedByNames]=useState<Record<string,string>>({})
  const [modifiedByNames,setModifiedByNames]=useState<Record<string,string>>({})
  const [query,setQuery]=useState('')
  const [categoryFilter,setCategoryFilter]=useState('all')
  const [statusFilter,setStatusFilter]=useState('all')
  const [audienceFilter,setAudienceFilter]=useState('all')
  const [createdFrom,setCreatedFrom]=useState('')
  const [createdTo,setCreatedTo]=useState('')
  const [publishedFrom,setPublishedFrom]=useState('')
  const [publishedTo,setPublishedTo]=useState('')
  const [sort,setSort]=useState('newest')
  const [page,setPage]=useState(1)
  const [pageSize,setPageSize]=useState(10)
  const [loading,setLoading]=useState(true)
  const [message,setMessage]=useState('')
  const [editor,setEditor]=useState(false)
  const [editing,setEditing]=useState<Announcement|null>(null)
  const [viewing,setViewing]=useState<Announcement|null>(null)

  const refresh=async()=>{
    if(!supabase)return
    setLoading(true)
    const [announcementResult,sectionResult]=await Promise.all([
      supabase.from('announcements').select('id,title,summary,body,audience,category,priority,status,content_format,published_at,expires_at,target_grade_level,target_section_id,attachments,created_by,last_modified_by,created_at,updated_at').order('created_at',{ascending:false}).limit(10000),
      supabase.from('sections').select('id,name,grade_level').order('grade_level').order('name'),
    ])
    if(announcementResult.error)setMessage(friendlyError(announcementResult.error))
    else {
      const next=(announcementResult.data??[]) as Announcement[];setRows(next)
      const ids=[...new Set(next.flatMap((r)=>[r.created_by,r.last_modified_by]).filter((id):id is string=>Boolean(id)))]
      if(ids.length){const {data}=await supabase.from('profiles').select('id,full_name').in('id',ids);const names=Object.fromEntries((data??[]).map((p)=>[p.id,p.full_name]));setCreatedByNames(names);setModifiedByNames(names)}
    }
    if(sectionResult.error)setMessage(friendlyError(sectionResult.error));else setSections(sectionResult.data??[])
    setLoading(false)
  }
  useEffect(()=>{void refresh()},[])

  const effectiveStatus=(a:Announcement):string=>a.status==='published'&&a.expires_at&&Date.parse(a.expires_at)<=Date.now()?'expired':a.status
  const filtered=useMemo(()=>rows.filter((a)=>{
    const text=`${a.title} ${a.summary??''} ${plainText(a.body)}`.toLowerCase()
    const created=a.created_at.slice(0,10);const published=(a.published_at??'').slice(0,10)
    return (!query||text.includes(query.toLowerCase().trim()))&&(categoryFilter==='all'||a.category===categoryFilter)&&(statusFilter==='all'||effectiveStatus(a)===statusFilter)&&(audienceFilter==='all'||a.audience===audienceFilter)&&(!createdFrom||created>=createdFrom)&&(!createdTo||created<=createdTo)&&(!publishedFrom||published>=publishedFrom)&&(!publishedTo||published<=publishedTo)
  }).sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):sort==='oldest'?a.created_at.localeCompare(b.created_at):sort==='publication'?String(b.published_at??'').localeCompare(String(a.published_at??'')):b.created_at.localeCompare(a.created_at)),[rows,query,categoryFilter,statusFilter,audienceFilter,createdFrom,createdTo,publishedFrom,publishedTo,sort])
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize))
  const pageRows=filtered.slice((page-1)*pageSize,page*pageSize)
  const now=Date.now()
  const counts={total:rows.length,published:rows.filter((r)=>r.status==='published'&&(!r.expires_at||Date.parse(r.expires_at)>now)&&!!r.published_at&&Date.parse(r.published_at)<=now).length,draft:rows.filter((r)=>r.status==='draft').length,scheduled:rows.filter((r)=>r.status==='scheduled'&&!!r.published_at&&Date.parse(r.published_at)>now).length,archived:rows.filter((r)=>r.status==='archived').length}
  const clearFilters=()=>{setQuery('');setCategoryFilter('all');setStatusFilter('all');setAudienceFilter('all');setCreatedFrom('');setCreatedTo('');setPublishedFrom('');setPublishedTo('');setSort('newest');setPage(1)}
  const openCreate=()=>{setEditing(null);setEditor(true)}
  const openEdit=(item:Announcement)=>{setEditing(item);setEditor(true)}
  const setStatus=async(item:Announcement,status:Status)=>{
    if(!supabase)return
    const label=status==='archived'?'archive':status==='unpublished'?'unpublish':status==='published'?'publish':'restore'
    await confirmAction({title:`${label[0].toUpperCase()+label.slice(1)} announcement?`,description:`This announcement will be ${status}.`,itemName:item.title,confirmLabel:`${label[0].toUpperCase()+label.slice(1)} announcement`,tone:status==='archived'?'danger':'primary',successMessage:`Announcement ${label}d.`,onConfirm:async()=>{const publishDate=status==='published'?(item.published_at&&Date.parse(item.published_at)<=Date.now()?item.published_at:new Date().toISOString()):item.published_at;const {error}=await supabase!.from('announcements').update({status,published_at:publishDate,last_modified_by:profileId,updated_at:new Date().toISOString()}).eq('id',item.id);if(error)throw error;if(status==='published')void supabase!.functions.invoke('dispatch-push',{body:{announcement_id:item.id}});await refresh()}})
  }
  const duplicate=async(item:Announcement)=>{
    if(!supabase)return
    const id=crypto.randomUUID()
    const {data,error}=await supabase.from('announcements').insert({id,title:`Copy of ${item.title}`,summary:item.summary,body:item.body,content_format:item.content_format,category:item.category,priority:item.priority,audience:item.audience,status:'draft',created_by:profileId,last_modified_by:profileId,attachments:[]}).select('id,title,summary,body,audience,category,priority,status,content_format,published_at,expires_at,target_grade_level,target_section_id,attachments,created_by,last_modified_by,created_at,updated_at').single()
    if(error)setMessage(friendlyError(error));else{setMessage('Draft copy created. Attachments were left on the original announcement.');await refresh();setEditing(data as Announcement);setEditor(true)}
  }
  const remove=async(item:Announcement)=>{
    if(!supabase)return
    await confirmAction({title:'Delete announcement permanently?',description:'This also removes its attached files. This action cannot be undone.',itemName:item.title,confirmLabel:'Delete announcement',tone:'danger',successMessage:'Announcement deleted.',onConfirm:async()=>{const {error:storageError}=item.attachments?.length?await supabase!.storage.from(bucket).remove(item.attachments.map((a)=>a.path)):{error:null};if(storageError)throw storageError;const {error}=await supabase!.from('announcements').delete().eq('id',item.id);if(error)throw error;await refresh()}})
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-[var(--color-brand-dark)]">School communication</p><h2 className="mt-1 text-2xl font-bold">Announcement management</h2><p className="mt-1 text-sm text-slate-500">Create, schedule, publish, and maintain portal announcements.</p></div><button onClick={openCreate} className="rounded-xl bg-[var(--color-brand-dark)] px-4 py-2.5 text-sm font-semibold text-white">+ Create announcement</button></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[['Total announcements',counts.total],['Published',counts.published],['Drafts',counts.draft],['Scheduled',counts.scheduled],['Archived',counts.archived]].map(([label,value])=><div key={String(label)} className="rounded-2xl border bg-white p-4 shadow-sm"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</div>
    {message&&<p role="status" className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{message}</p>}
    <section className="rounded-3xl border bg-white p-4 shadow-sm sm:p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-bold">Announcement directory</h3><p className="text-sm text-slate-500">{filtered.length} matching announcement{filtered.length===1?'':'s'}</p></div><button onClick={()=>void refresh()} className="rounded-xl border px-3 py-2 text-sm">Refresh</button></div>
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><input value={query} onChange={(e)=>{setQuery(e.target.value);setPage(1)}} placeholder="Search title and content" className="rounded-xl border px-3 py-2 text-sm xl:col-span-2"/><select value={categoryFilter} onChange={(e)=>setCategoryFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All categories</option>{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All statuses</option>{['draft','scheduled','published','unpublished','archived','expired'].map((v)=><option key={v} value={v}>{capitalize(v)}</option>)}</select><select value={audienceFilter} onChange={(e)=>setAudienceFilter(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="all">All audiences</option>{audiences.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">Created from<input type="date" value={createdFrom} onChange={(e)=>setCreatedFrom(e.target.value)} className="min-w-0 flex-1 py-2 text-sm text-slate-800"/></label><label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">Created to<input type="date" value={createdTo} onChange={(e)=>setCreatedTo(e.target.value)} className="min-w-0 flex-1 py-2 text-sm text-slate-800"/></label><label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">Publish from<input type="date" value={publishedFrom} onChange={(e)=>setPublishedFrom(e.target.value)} className="min-w-0 flex-1 py-2 text-sm text-slate-800"/></label><label className="flex items-center gap-2 rounded-xl border px-2 text-xs text-slate-500">Publish to<input type="date" value={publishedTo} onChange={(e)=>setPublishedTo(e.target.value)} className="min-w-0 flex-1 py-2 text-sm text-slate-800"/></label><select value={sort} onChange={(e)=>setSort(e.target.value)} className="rounded-xl border px-3 py-2 text-sm"><option value="newest">Newest created</option><option value="oldest">Oldest created</option><option value="publication">Publication date</option><option value="title">Title A–Z</option></select><button onClick={clearFilters} className="rounded-xl border px-3 py-2 text-sm font-semibold">Clear filters</button></div>
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{['Announcement','Category','Priority','Status','Audience','Created','Publication','Modified by','Actions'].map((h)=><th key={h} className="whitespace-nowrap px-3 py-3 font-semibold">{h}</th>)}</tr></thead><tbody>{pageRows.map((a)=><tr key={a.id} className="border-t align-top"><td className="min-w-64 px-3 py-3"><b>{a.title}</b><p className="mt-1 line-clamp-2 text-xs text-slate-500">{a.summary||plainText(a.body)}</p>{a.attachments?.length>0&&<span className="mt-1 block text-[11px] text-slate-500">📎 {a.attachments.length} attachment(s)</span>}</td><td className="px-3 py-3">{categoryLabel(a.category)}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${priorityColor[a.priority]??priorityColor.normal}`}>{a.priority}</span></td><td className="px-3 py-3"><StatusTag value={effectiveStatus(a)}/></td><td className="px-3 py-3">{audienceLabel(a.audience)}{a.target_grade_level&&<span className="block text-xs text-slate-500">Grade {a.target_grade_level}</span>}{a.target_section_id&&<span className="block text-xs text-slate-500">{sections.find((s)=>s.id===a.target_section_id)?.name}</span>}</td><td className="whitespace-nowrap px-3 py-3">{dateTime(a.created_at)}<span className="mt-1 block text-xs text-slate-500">By {createdByNames[a.created_by??'']??'—'}</span></td><td className="whitespace-nowrap px-3 py-3">{dateTime(a.published_at)}</td><td className="px-3 py-3">{modifiedByNames[a.last_modified_by??'']??'—'}<span className="mt-1 block text-xs text-slate-500">{dateTime(a.updated_at)}</span></td><td className="min-w-56 px-3 py-3"><div className="flex flex-wrap gap-x-3 gap-y-2"><button onClick={()=>setViewing(a)} className="font-semibold text-emerald-800">View</button><button onClick={()=>openEdit(a)} className="font-semibold text-emerald-800">Edit</button><button onClick={()=>void duplicate(a)} className="font-semibold text-emerald-800">Duplicate</button>{(a.status==='draft'||a.status==='unpublished')&&<button onClick={()=>void setStatus(a,'published')} className="font-semibold text-emerald-800">Publish</button>}{a.status==='published'&&<><button onClick={()=>void setStatus(a,'unpublished')} className="font-semibold text-amber-800">Unpublish</button><button onClick={()=>void setStatus(a,'archived')} className="font-semibold text-amber-800">Archive</button></>}{a.status==='scheduled'&&<button onClick={()=>void setStatus(a,'unpublished')} className="font-semibold text-amber-800">Cancel schedule</button>}{a.status==='archived'&&<button onClick={()=>void setStatus(a,a.published_at&&Date.parse(a.published_at)>Date.now()?'scheduled':'published')} className="font-semibold text-emerald-800">Restore</button>}<button onClick={()=>void remove(a)} className="font-semibold text-rose-700">Delete</button></div></td></tr>)}{!pageRows.length&&<tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">{loading?'Loading announcements…':'No announcements match these filters.'}</td></tr>}</tbody></table></div>
      <div className="mt-4 flex flex-wrap justify-between gap-3 text-sm"><label className="flex items-center gap-2">Rows<select value={pageSize} onChange={(e)=>{setPageSize(Number(e.target.value));setPage(1)}} className="rounded-lg border px-2 py-1"><option>10</option><option>25</option><option>50</option></select></label><div className="flex items-center gap-3"><span>Page {page} of {pages}</span><button disabled={page===1} onClick={()=>setPage(page-1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Previous</button><button disabled={page===pages} onClick={()=>setPage(page+1)} className="rounded-lg border px-3 py-1 disabled:opacity-40">Next</button></div></div>
    </section>
    {editor&&<AnnouncementEditor profileId={profileId} sections={sections} item={editing} onClose={()=>setEditor(false)} onSaved={async(text)=>{setMessage(text);setEditor(false);await refresh()}} />}
    {viewing&&<div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4" onClick={()=>setViewing(null)}><article onClick={(e)=>e.stopPropagation()} role="dialog" aria-modal="true" className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6"><div className="flex justify-between"><div><div className="flex gap-2"><StatusTag value={effectiveStatus(viewing)}/><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${priorityColor[viewing.priority]??priorityColor.normal}`}>{viewing.priority}</span></div><h2 className="mt-3 text-2xl font-bold">{viewing.title}</h2></div><button onClick={()=>setViewing(null)} className="h-fit rounded-lg border px-3 py-1.5">Close</button></div>{viewing.summary&&<p className="mt-3 text-slate-600">{viewing.summary}</p>}<div className="mt-5"><SafeContent item={viewing}/></div><SignedAttachments items={viewing.attachments??[]}/><p className="mt-5 text-xs text-slate-500">Created {dateTime(viewing.created_at)} by {createdByNames[viewing.created_by??'']??'—'} · Modified {dateTime(viewing.updated_at)} by {modifiedByNames[viewing.last_modified_by??'']??'—'}</p></article></div>}
  </div>
}

type EditorProps={profileId:string;sections:Section[];item:Announcement|null;onClose:()=>void;onSaved:(message:string)=>void}
function AnnouncementEditor({profileId,sections,item,onClose,onSaved}:EditorProps){
  const editorRef=useRef<HTMLDivElement>(null)
  const savedRange=useRef<Range|null>(null)
  const [title,setTitle]=useState(item?.title??'')
  const [summary,setSummary]=useState(item?.summary??'')
  const [body,setBody]=useState(item?.body??'')
  const [linkUrl,setLinkUrl]=useState('')
  const [category,setCategory]=useState(item?.category??'general')
  const [priority,setPriority]=useState(item?.priority??'normal')
  const [audience,setAudience]=useState(item?.audience??'all')
  const [grade,setGrade]=useState(item?.target_grade_level??'')
  const [section,setSection]=useState(item?.target_section_id??'')
  const [status,setStatus]=useState<Status>(item?.status??'draft')
  const [publishAt,setPublishAt]=useState(localInput(item?.published_at??null))
  const [expiresAt,setExpiresAt]=useState(localInput(item?.expires_at??null))
  const [kept]=useState<Attachment[]>(item?.attachments??[])
  const [removePaths,setRemovePaths]=useState<string[]>([])
  const [files,setFiles]=useState<File[]>([])
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  const [focusReady,setFocusReady]=useState(false)
  const [showPreview,setShowPreview]=useState(false)
  const maxSize=10*1024*1024

  useEffect(()=>{if(editorRef.current&&!focusReady){editorRef.current.innerHTML=DOMPurify.sanitize(item?.body??'');setFocusReady(true)}},[item,focusReady])
  const command=(cmd:string,value?:string)=>{editorRef.current?.focus();document.execCommand(cmd,false,value);if(editorRef.current)setBody(editorRef.current.innerHTML)}
  const insertLink=()=>{const url=linkUrl.trim();if(!/^https?:\/\//i.test(url)){setMessage('Enter a valid link beginning with http:// or https://.');return}const selection=window.getSelection();if(selection&&savedRange.current){selection.removeAllRanges();selection.addRange(savedRange.current)}command('createLink',url);setLinkUrl('')}
  const addFiles=(list:FileList|null)=>{if(!list)return;const accepted:File[]=[];for(const file of Array.from(list)){const valid=['image/jpeg','image/png','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.type);if(!valid||file.size>maxSize){setMessage(`${file.name} was skipped. Use JPG, PNG, PDF, or DOCX files up to 10 MB.`);continue}accepted.push(file)}setFiles((old)=>[...old,...accepted])}
  const uploadFiles=async(id:string)=>{
    if(!supabase)return [] as Attachment[]
    const uploaded:Attachment[]=[]
    for(const file of files){const safeName=file.name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').slice(-120);const path=`${id}/${crypto.randomUUID()}-${safeName}`;const {error}=await supabase.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false});if(error){if(uploaded.length)await supabase.storage.from(bucket).remove(uploaded.map((a)=>a.path));throw error}uploaded.push({name:file.name,path,mime_type:file.type,size:file.size})}
    return uploaded
  }
  const save=async(nextStatus:Status)=>{
    if(!supabase)return
    const cleanTitle=title.trim();const cleanBody=DOMPurify.sanitize(body,{USE_PROFILES:{html:true}})
    if(!cleanTitle||!plainText(cleanBody)){setMessage('Enter an announcement title and message.');return}
    if(nextStatus==='scheduled'&&(!publishAt||Date.parse(publishAt)<=Date.now())){setMessage('Choose a future publication date and time to schedule this announcement.');return}
    const publishDate=nextStatus==='published'?new Date().toISOString():nextStatus==='scheduled'?new Date(publishAt).toISOString():item?.published_at??null
    const expiration=expiresAt?new Date(expiresAt).toISOString():null
    if(expiration&&publishDate&&Date.parse(expiration)<=Date.parse(publishDate)){setMessage('Expiration must be later than publication.');return}
    setBusy(true);setMessage('Saving announcement…')
    const id=item?.id??crypto.randomUUID();let uploaded:Attachment[]=[]
    try{uploaded=await uploadFiles(id)}catch(error){setBusy(false);setMessage(friendlyError(error, 'File upload failed.'));return}
    const payload={id,title:cleanTitle,summary:summary.trim()||null,body:cleanBody,content_format:'html',category,priority,audience,status:nextStatus,published_at:publishDate,expires_at:expiration,target_grade_level:audience==='student'&&grade?grade:null,target_section_id:audience==='student'&&section?section:null,attachments:[...kept.filter((a)=>!removePaths.includes(a.path)),...uploaded],last_modified_by:profileId,updated_at:new Date().toISOString(),...(item?{}:{created_by:profileId})}
    const result=item?await supabase.from('announcements').update(payload).eq('id',id):await supabase.from('announcements').insert(payload)
    if(result.error){if(uploaded.length)await supabase.storage.from(bucket).remove(uploaded.map((a)=>a.path));setBusy(false);setMessage(friendlyError(result.error));return}
    if(removePaths.length){const {error}=await supabase.storage.from(bucket).remove(removePaths);if(error)setMessage(`Announcement saved, but an old attachment could not be deleted: ${friendlyError(error)}`);else if(item){const {error:logError}=await supabase.rpc('record_announcement_attachment_activity',{p_announcement_id:id,p_action:'removed',p_file_count:removePaths.length});if(logError)setMessage(`Announcement saved, but attachment audit logging failed: ${friendlyError(logError)}`)}}
    if(uploaded.length){const {error:logError}=await supabase.rpc('record_announcement_attachment_activity',{p_announcement_id:id,p_action:'uploaded',p_file_count:uploaded.length});if(logError)setMessage(`Announcement saved, but attachment audit logging failed: ${friendlyError(logError)}`)}
    if(nextStatus==='published')void supabase.functions.invoke('dispatch-push',{body:{announcement_id:id}})
    setBusy(false);onSaved(item?(nextStatus===item.status?'Announcement changes saved.':`Announcement ${nextStatus}.`):nextStatus==='draft'?'Draft saved.':nextStatus==='scheduled'?'Announcement scheduled.':'Announcement published.')
  }

  const toolbar=(label:string,cmd:string,value?:string)=><button type="button" title={label} onMouseDown={(e)=>e.preventDefault()} onClick={()=>command(cmd,value)} className="rounded-lg border bg-white px-2.5 py-1.5 text-sm font-semibold hover:bg-emerald-50">{label}</button>
  const statusOptions:Status[]=['draft','scheduled','published','unpublished','archived']
  const signedExisting=item?.attachments??[]
  return <><div className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/50 p-3 sm:p-6" onClick={onClose}><form onSubmit={(e)=>{e.preventDefault();void save(item?.status??'draft')}} onClick={(e)=>e.stopPropagation()} className="max-h-[95vh] w-full max-w-5xl overflow-y-auto rounded-3xl bg-slate-50 shadow-2xl">
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-white px-5 py-4"><div><p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Announcement editor</p><h2 className="text-xl font-bold">{item?'Edit announcement':'Create announcement'}</h2></div><button type="button" onClick={onClose} className="rounded-xl border px-3 py-2">Cancel</button></div>
    <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="space-y-5">
        <section className="rounded-2xl border bg-white p-4 sm:p-5"><h3 className="mb-4 font-bold">Announcement information</h3><div className="space-y-3"><label className="block text-sm font-semibold">Title<input required maxLength={180} value={title} onChange={(e)=>setTitle(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" placeholder="Write a clear announcement title"/></label><label className="block text-sm font-semibold">Short description<textarea rows={2} maxLength={400} value={summary} onChange={(e)=>setSummary(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" placeholder="A short summary shown in portal cards"/></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-semibold">Category<select value={category} onChange={(e)=>setCategory(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5">{categories.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm font-semibold">Priority<select value={priority} onChange={(e)=>setPriority(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5">{priorities.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase ${priorityColor[priority]}`}>{priority} priority</span></div></section>
        <section className="rounded-2xl border bg-white p-4 sm:p-5"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold">Announcement content</h3><span className="text-xs text-slate-500">Formatting is sanitized before storage and display</span></div><div className="mb-2 flex flex-wrap gap-1.5">{toolbar('B','bold')}{toolbar('I','italic')}{toolbar('U','underline')}{toolbar('H2','formatBlock','h2')}{toolbar('H3','formatBlock','h3')}{toolbar('¶','formatBlock','p')}{toolbar('• List','insertUnorderedList')}{toolbar('1. List','insertOrderedList')}{toolbar('Quote','formatBlock','blockquote')}{toolbar('←','justifyLeft')}{toolbar('Center','justifyCenter')}{toolbar('→','justifyRight')}<button type="button" onMouseDown={(e)=>{const selection=window.getSelection();savedRange.current=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;e.preventDefault()}} onClick={()=>document.querySelector<HTMLInputElement>("input[type=url]")?.focus()} className="rounded-lg border bg-white px-2.5 py-1.5 text-sm font-semibold">Link</button><button type="button" onMouseDown={(e)=>e.preventDefault()} onClick={()=>command('hiliteColor','#fff1a8')} className="rounded-lg border bg-white px-2.5 py-1.5 text-sm font-semibold">Highlight</button></div><div className="mb-2 flex gap-2"><input aria-label="Link URL" type="url" value={linkUrl} onChange={e=>setLinkUrl(e.target.value)} placeholder="https://example.com" className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"/><button type="button" onClick={insertLink} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white">Add link</button></div><div ref={editorRef} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" onInput={(e)=>setBody(e.currentTarget.innerHTML)} className="min-h-64 rounded-xl border border-slate-200 p-4 text-sm leading-6 outline-none focus:border-emerald-700 focus:ring-4 focus:ring-emerald-700/10"/><p className="mt-2 text-xs text-slate-500">Use the toolbar to format text, headings, lists, links, quotes, and alignment.</p></section>
        <section className="rounded-2xl border bg-white p-4 sm:p-5"><h3 className="mb-2 font-bold">Attachments and media</h3><p className="mb-3 text-xs text-slate-500">JPG, PNG, PDF, or DOCX · up to 10 MB per file</p><input type="file" multiple accept="image/jpeg,image/png,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e)=>addFiles(e.target.files)} className="block w-full text-sm"/><div className="mt-3 space-y-2">{signedExisting.filter((a)=>!removePaths.includes(a.path)).map((a)=><div key={a.path} className="flex items-center justify-between gap-3 rounded-xl border p-2.5 text-sm"><span className="truncate">{a.name}</span><button type="button" onClick={()=>setRemovePaths((old)=>[...old,a.path])} className="font-semibold text-rose-700">Remove</button></div>)}{signedExisting.filter((a)=>removePaths.includes(a.path)).map((a)=><div key={`removed-${a.path}`} className="flex justify-between text-xs text-slate-400"><span className="line-through">{a.name}</span><button type="button" onClick={()=>setRemovePaths((old)=>old.filter((p)=>p!==a.path))}>Undo</button></div>)}{files.map((file,i)=><div key={`${file.name}-${i}`} className="flex items-center justify-between gap-3 rounded-xl border p-2.5 text-sm"><span className="truncate">{file.name} · {(file.size/1024/1024).toFixed(1)} MB</span><button type="button" onClick={()=>setFiles((old)=>old.filter((_,index)=>index!==i))} className="font-semibold text-rose-700">Remove</button></div>)}</div></section>
      </div>
      <aside className="space-y-5"><section className="rounded-2xl border bg-white p-4"><h3 className="mb-3 font-bold">Target audience</h3><label className="block text-sm font-semibold">Who can view<select value={audience} onChange={(e)=>{setAudience(e.target.value);if(e.target.value!=='student'){setGrade('');setSection('')}}} className="mt-1 w-full rounded-xl border px-3 py-2.5">{audiences.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>{audience==='student'&&<><label className="mt-3 block text-sm font-semibold">Grade level (optional)<input value={grade} onChange={(e)=>{setGrade(e.target.value);setSection('')}} className="mt-1 w-full rounded-xl border px-3 py-2.5" placeholder="All grades"/></label>{grade&&<label className="mt-3 block text-sm font-semibold">Section (optional)<select value={section} onChange={(e)=>setSection(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="">All sections in grade</option>{sections.filter((s)=>s.grade_level===grade).map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}</>}</section>
        <section className="rounded-2xl border bg-white p-4"><h3 className="mb-3 font-bold">Publication settings</h3><label className="block text-sm font-semibold">Status<select value={status} onChange={(e)=>setStatus(e.target.value as Status)} className="mt-1 w-full rounded-xl border px-3 py-2.5">{statusOptions.map((s)=><option key={s} value={s}>{capitalize(s)}</option>)}</select></label><label className="mt-3 block text-sm font-semibold">Publication date and time<input type="datetime-local" value={publishAt} onChange={(e)=>setPublishAt(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><label className="mt-3 block text-sm font-semibold">Expiration (optional)<input type="datetime-local" value={expiresAt} onChange={(e)=>setExpiresAt(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"/></label><p className="mt-3 text-xs leading-5 text-slate-500">Scheduled announcements become visible automatically at the publication time. Expired notices are hidden from portal feeds.</p></section>
      </aside>
    </div>
    {message&&<p role="alert" className="mx-4 mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 sm:mx-6">{message}</p>}
    <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-white px-4 py-4 sm:px-6"><span className="text-xs text-slate-500">{item?`Created ${dateTime(item.created_at)} · Last modified ${dateTime(item.updated_at)}`:'New announcement'}</span><div className="flex flex-wrap gap-2"><button type="button" onClick={()=>setShowPreview(true)} className="rounded-xl border px-3 py-2 text-sm font-semibold">Preview</button><button type="button" disabled={busy} onClick={()=>void save('draft')} className="rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-50">Save draft</button>{item&&<button type="button" disabled={busy} onClick={()=>void save(item.status)} className="rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-50">Save changes</button>}<button type="button" disabled={busy} onClick={()=>void save('scheduled')} className="rounded-xl border border-emerald-800 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:opacity-50">{busy?'Saving…':'Schedule'}</button><button type="button" disabled={busy} onClick={()=>void save('published')} className="rounded-xl bg-emerald-800 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?'Saving…':'Publish announcement'}</button></div></div>
  </form></div>{showPreview&&<div className="fixed inset-0 z-[75] flex items-center justify-center bg-slate-950/60 p-4" onClick={()=>setShowPreview(false)}><article onClick={(e)=>e.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-6"><div className="flex justify-between"><div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase">{categoryLabel(category)}</span><span className={`ml-2 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${priorityColor[priority]}`}>{priority}</span></div><button onClick={()=>setShowPreview(false)} className="rounded-lg border px-3 py-1">Close preview</button></div><h2 className="mt-4 text-2xl font-bold">{title||'Announcement title'}</h2>{summary&&<p className="mt-2 text-slate-600">{summary}</p>}<div className="announcement-content mt-5" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(body)}}/>{(kept.filter((a)=>!removePaths.includes(a.path)).length+files.length)>0&&<div className="mt-4 space-y-2"><p className="text-sm font-semibold">Attachments</p>{kept.filter((a)=>!removePaths.includes(a.path)).map((a)=><p key={a.path} className="text-sm">📎 {a.name}</p>)}{files.map((f,i)=><p key={`${f.name}-${i}`} className="text-sm">📎 {f.name} (will upload when saved)</p>)}</div>}<p className="mt-5 text-xs text-slate-500">{audienceLabel(audience)} · {status==='scheduled'?`Scheduled ${publishAt||'time not set'}`:status==='published'?'Publish now':capitalize(status)}</p></article></div>}</>
}

function StatusTag({value}:{value:string}){const colors:Record<string,string>={published:'bg-emerald-100 text-emerald-800',draft:'bg-slate-100 text-slate-700',scheduled:'bg-sky-100 text-sky-800',unpublished:'bg-amber-100 text-amber-900',archived:'bg-slate-200 text-slate-600',expired:'bg-rose-100 text-rose-800'};return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${colors[value]??colors.draft}`}>{value}</span>}
function categoryLabel(value:string){return categories.find(([key])=>key===value)?.[1]??value}
function audienceLabel(value:string){return audiences.find(([key])=>key===value)?.[1]??value}
function capitalize(value:string){return value.charAt(0).toUpperCase()+value.slice(1)}
