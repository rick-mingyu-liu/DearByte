// Turns iLink messages into companion turns.

import { ItemType, MessageType, type MessageItem, type WeixinMessage } from "./types.ts";

export type ImageRef = NonNullable<MessageItem["image_item"]>;

export type Inbound = {
  messageId: string | null;
  from: string;
  contextToken: string;
  text: string;
  image: ImageRef | null;
};

/**
 * Reads one incoming message. Returns null for anything the companion should
 * not answer: the bot's own messages, group messages, or messages without a
 * context token (a reply is impossible without one).
 */
export function readMessage(msg: WeixinMessage): Inbound | null {
  if (msg.message_type !== MessageType.USER || msg.group_id || !msg.from_user_id || !msg.context_token) return null;

  const parts: string[] = [];
  let image: ImageRef | null = null;
  for (const item of msg.item_list ?? []) {
    const quoted = item.ref_msg?.title ?? item.ref_msg?.message_item?.text_item?.text;
    if (quoted) parts.push(`（引用了：「${quoted}」）`);
    switch (item.type) {
      case ItemType.TEXT:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case ItemType.IMAGE:
        if (item.image_item && !image) image = item.image_item;
        break;
      case ItemType.VOICE:
        // WeChat transcribes voice itself; without a transcript we can't hear it.
        parts.push(item.voice_item?.text || "（用户发了一条语音，你听不到内容）");
        break;
      case ItemType.FILE:
        parts.push(`（用户发了一个文件${item.file_item?.file_name ? `「${item.file_item.file_name}」` : ""}，你打不开文件）`);
        break;
      case ItemType.VIDEO:
        parts.push("（用户发了一个视频，你看不了视频）");
        break;
    }
  }
  if (!parts.length && !image) return null;

  return {
    messageId: msg.message_id ?? null,
    from: msg.from_user_id,
    contextToken: msg.context_token,
    text: parts.join("\n"),
    image,
  };
}

/**
 * People often send several short messages in a row. They become one turn:
 * texts joined in order, the latest photo attached, the latest context token.
 */
export function mergeInbound(batch: Inbound[]): Inbound {
  const last = batch[batch.length - 1];
  const images = batch.filter((m) => m.image);
  const texts = batch.map((m) => m.text).filter(Boolean);
  if (images.length > 1) texts.push(`（用户还发了另外 ${images.length - 1} 张图，你只看到了最后一张）`);
  return {
    messageId: last.messageId,
    from: last.from,
    contextToken: last.contextToken,
    text: texts.join("\n"),
    image: images.at(-1)?.image ?? null,
  };
}
