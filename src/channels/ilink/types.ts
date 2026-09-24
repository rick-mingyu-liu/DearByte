// iLink wire types: the subset DearByte uses. Field names and values follow
// Tencent's official client (@tencent-weixin/openclaw-weixin 2.4.9, MIT).

export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { FINISH: 2 } as const;
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

/** getupdates / getconfig errcode for an expired bot token. */
export const STALE_TOKEN_ERRCODE = -14;

export type CdnMedia = {
  encrypt_query_param?: string;
  /** base64 of either 16 raw key bytes or a 32-char hex string. */
  aes_key?: string;
  full_url?: string;
};

export type MessageItem = {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CdnMedia; /** hex; preferred over media.aes_key */ aeskey?: string };
  /** `text` is WeChat's own speech-to-text transcript, when available. */
  voice_item?: { text?: string; playtime?: number };
  file_item?: { file_name?: string };
  video_item?: Record<string, unknown>;
  ref_msg?: { title?: string; message_item?: MessageItem };
};

export type WeixinMessage = {
  seq?: number;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  group_id?: string;
  message_type?: number;
  item_list?: MessageItem[];
  context_token?: string;
};

export type GetUpdatesResp = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export type QrStatusResp = {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** The WeChat user who scanned the code: the only person the bot answers. */
  ilink_user_id?: string;
  redirect_host?: string;
};
