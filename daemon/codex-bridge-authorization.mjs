// Group policies never widen callbacks or the exact bound-chat boundary.
export function isAuthorizedMessage(binding,event) {
  if (!event || event.type !== 'im.message.receive_v1' || event.chat_id !== binding.chat_id) return false;
  if(binding.group_access!==undefined && !['all_members_mentions','all_group_humans'].includes(binding.group_access))return false;
  if (!['all_members_mentions','all_group_humans'].includes(binding.group_access)) return event.sender_id === binding.allowed_sender_id;
  if (event.chat_type !== 'group' || event.sender_type !== 'user'
      || !/^ou_[A-Za-z0-9]+$/.test(event.sender_id ?? '')
      || !/^ou_[A-Za-z0-9]+$/.test(binding.bot_open_id ?? '')
      || event.sender_id === binding.bot_open_id) return false;
  return binding.group_access === 'all_group_humans' || Array.isArray(event.mentions) && event.mentions.some(m =>
      (typeof m?.id === 'string' ? m.id : m?.id?.open_id) === binding.bot_open_id);
}
