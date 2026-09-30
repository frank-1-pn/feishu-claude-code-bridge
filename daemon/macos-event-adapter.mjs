export function normalizeCallback(event) {
  if(event.type!=='card.action.trigger'||event.event)return event;
  const parse=v=>typeof v==='string'?JSON.parse(v||'{}'):v||{};
  return {header:{event_type:event.type,event_id:event.event_id,create_time:event.timestamp},event:{operator:{open_id:event.operator_id},context:{open_chat_id:event.chat_id,open_message_id:event.message_id},token:event.token,action:{tag:event.action_tag,name:event.action_name,value:parse(event.action_value),form_value:parse(event.form_value),input_value:event.input_value,option:event.option,options:event.options,checked:event.checked,timezone:event.timezone}}};
}
