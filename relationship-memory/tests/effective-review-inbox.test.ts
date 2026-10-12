import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelationshipMemoryStore } from '../src/store/index.js';
import { RelationshipMemoryRuntime } from '../src/tools/index.js';
import { RelationshipMemoryResolutionControlPlane, materializeCurrentMemoryView } from '../src/resolution/index.js';
import { projectRelationReviewInbox, findProjectedReview } from '../src/review_inbox.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir,{recursive:true,force:true})));
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'effective-inbox-'));dirs.push(root);
  const store=new RelationshipMemoryStore(root,'kohaku');
  const runtime=new RelationshipMemoryRuntime(store,new Map());
  const owner=new RelationshipMemoryResolutionControlPlane(store);
  const add=(id:string,links:string[]=[])=>store.appendMemory({
    schema_version:1,memory_id:id,subject_id:'kohaku',kind:'user_preference',
    summary:'事实'+id,participants:['user'],payload:{topic:id,preference:'事实'+id},
    status:'active',observed_at:'2026-10-12T00:00:00.000Z',
    created_at:'2026-10-12T00:00:00.000Z',source_key:id,dedupe_key:id,linked_memory_ids:links,
  },[]);
  const propose=(ids:string[],relation:'same_meaning'|'related'='same_meaning')=>{
    const r=runtime.suggestMaintenanceReview('batch','relation',{memory_ids:ids,relation,reason:'候选'});
    expect(r.outcome).toBe('accepted');return r.review_id!;
  };
  const inbox=()=>projectRelationReviewInbox(store,materializeCurrentMemoryView(store));
  return {store,owner,add,propose,inbox};
}
describe('effective Review inbox',()=>{
 it('projects pending A-B-C into A-C, resolves using original review ID, and supports undo',()=>{
   const {owner,add,propose,inbox,store}=fixture();
   add('A');add('B');add('C');
   const ab=propose(['A','B']),abc=propose(['A','B','C']);
   owner.resolveReview(ab,{resolution_id:'ab',relation:'same_meaning',target_memory_id:'A'});
   expect(findProjectedReview(inbox(),abc)?.memory_ids).toEqual(['A','C']);
   const result=owner.resolveReview(abc,{resolution_id:'ac',relation:'same_meaning',target_memory_id:'A'});
   expect(result.memory_ids).toEqual(['A','C']);
   expect(result.original_memory_ids).toEqual(['A','B','C']);
   expect(inbox().reviews).toHaveLength(0);
   owner.undoReview(abc,{resolution_id:'undo-ac'});
   expect(findProjectedReview(inbox(),abc)?.memory_ids).toEqual(['A','C']);
   owner.undoReview(ab,{resolution_id:'undo-ab'});
   expect(findProjectedReview(inbox(),abc)?.memory_ids).toEqual(['A','B','C']);
   expect(store.listMemories()).toHaveLength(3);
 });
 it('deduplicates reciprocal raw links and combines them with an explicit suggestion',()=>{
   const {owner,add,propose,inbox}=fixture();
   add('A',['B']);add('B',['A']);
   expect(inbox().reviews).toHaveLength(1);
   const hint=inbox().reviews[0].review_id;
   expect(inbox().reviews[0].origin).toBe('remember_link');
   const review=propose(['A','B'],'related');
   expect(inbox().reviews).toHaveLength(1);
   expect(findProjectedReview(inbox(),hint)?.origin_review_ids).toContain(review);
   owner.resolveReview(review,{resolution_id:'rel',relation:'related'});
   expect(inbox().reviews).toHaveLength(0);
 });
 it('moves a canonical link automatically on merge and back on undo',()=>{
   const {owner,add,propose,inbox}=fixture();
   add('A');add('B',['C']);add('C');
   const id=inbox().reviews[0].review_id;
   const ab=propose(['A','B']);
   owner.resolveReview(ab,{resolution_id:'ab',relation:'same_meaning',target_memory_id:'A'});
   expect(findProjectedReview(inbox(),id)?.memory_ids).toEqual(['A','C']);
   owner.undoReview(ab,{resolution_id:'undo-ab'});
   expect(findProjectedReview(inbox(),id)?.memory_ids).toEqual(['B','C']);
 });
 it('manually dismisses a virtual hint without recording unrelated',()=>{
   const {owner,add,inbox,store}=fixture();
   add('A',['B']);add('B');
   const id=inbox().reviews[0].review_id;
   owner.dismissReview(id,'旧线索');
   expect(inbox().reviews).toHaveLength(0);
   expect(store.listActiveMemoryResolutions()).toHaveLength(0);
 });
});
