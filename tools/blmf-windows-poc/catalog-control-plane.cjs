'use strict';
const Base=require('../../controller/blmf/control_plane');
const ACTIONS=new Set(['SELECT_PREVIOUS','SELECT_NEXT','SELECT_ENTRY','EXECUTE_SELECTED']);
// Dedicated PoC extension; production command whitelist and TAKE remain untouched.
class CatalogControlPlane extends Base {
 constructor(options){super(options);this.selectionAction=options.selectionAction;}
 async command(operator,payload){
  if(!ACTIONS.has(payload?.command))return super.command(operator,payload);
  const replay=this.ledger.accept({operatorId:operator.id,bridgeId:payload.bridgeId,sessionId:payload.sessionId,commandId:payload.commandId,sequence:payload.sequence,sentAt:payload.sentAt});
  if(!replay.ok)return replay;
  const authorize=()=>this.lease.isDirector(operator.id,payload.bridgeId);
  if(!authorize())return {ok:false,reason:'director_required'};
  return this.selectionAction(payload.command,payload.entryId,{authorize,isFresh:()=>this.ledger.isFresh(payload.sentAt)});
 }
}
module.exports=CatalogControlPlane;
