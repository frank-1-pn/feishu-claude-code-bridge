// Group access is opt-in and always restricted to one chat and an exact bot mention.
export function isAuthorizedMessage(binding,event) {
  if (!event || event.type !== 'im.message.receive_v1' || event.chat_id !== binding.chat_id) return false;
  if (binding.group_access !== 'all_members_mentions') return event.sender_id === binding.allowed_sender_id;
  return event.chat_type === 'group' && event.sender_type === 'user'
    && /^ou_[A-Za-z0-9]+$/.test(event.sender_id ?? '')
    && /^ou_[A-Za-z0-9]+$/.test(binding.bot_open_id ?? '')
    && Array.isArray(event.mentions) && event.mentions.some(m =>
      (typeof m.id === 'string' ? m.id : m.id?.open_id) === binding.bot_open_id);
}
