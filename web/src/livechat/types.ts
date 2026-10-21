/*
 * InnerTube（YouTube 内部 API）応答のうち、ライブチャットで読む部分だけの型。
 * 実際の応答はもっと大きく、仕様変更で形が変わり得るので、すべて省略可能として扱う。
 */

export interface Run {
  text?: string;
  emoji?: {
    shortcuts?: string[];
    image?: { thumbnails?: { url: string }[] };
  };
}

/** YouTube の「テキスト」: simpleText か runs のどちらか */
export interface YtText {
  simpleText?: string;
  runs?: Run[];
}

interface AuthorBadge {
  liveChatAuthorBadgeRenderer?: {
    icon?: { iconType?: string };
    customThumbnail?: unknown;
  };
}

/** チャットの 1 件（通常・スーパーチャット・スーパーステッカー・メンバー加入で共通して読むフィールド） */
export interface MessageRenderer {
  id?: string;
  timestampUsec?: string;
  message?: YtText;
  authorBadges?: AuthorBadge[];
  purchaseAmountText?: YtText;
  bodyBackgroundColor?: number;
  headerSubtext?: YtText;
  headerPrimaryText?: YtText;
}

export interface ChatItem {
  liveChatTextMessageRenderer?: MessageRenderer;
  liveChatPaidMessageRenderer?: MessageRenderer;
  liveChatPaidStickerRenderer?: MessageRenderer;
  liveChatMembershipItemRenderer?: MessageRenderer;
}

export interface ChatAction {
  addChatItemAction?: { item?: ChatItem };
}

export interface ReplayAction {
  replayChatItemAction?: {
    videoOffsetTimeMsec?: string;
    actions?: ChatAction[];
  };
}

export interface ContinuationData {
  continuation: string;
  timeoutMs?: number;
}

export interface Continuation {
  // 配信中
  invalidationContinuationData?: ContinuationData;
  timedContinuationData?: ContinuationData;
  reloadContinuationData?: ContinuationData;
  // アーカイブ
  liveChatReplayContinuationData?: ContinuationData;
  playerSeekContinuationData?: ContinuationData;
}

/** /next の応答の中にある、チャット欄の情報 */
export interface LiveChatRenderer {
  continuations?: Continuation[];
  isReplay?: boolean;
  actionPanel?: unknown;
}

/** get_live_chat / get_live_chat_replay の応答 */
export interface ContinuationResponse {
  continuationContents?: {
    liveChatContinuation?: {
      continuations?: Continuation[];
      actions?: (ChatAction & ReplayAction)[];
      actionPanel?: unknown;
    };
  };
}

/** send_message の応答 */
export interface SendMessageResponse {
  actions?: ChatAction[];
  error?: { message?: unknown };
}

/** 投稿欄（actionPanel の中） */
export interface MessageInputRenderer {
  sendButton?: unknown;
  maxCharacterLimit?: number;
}

export interface RestrictedParticipationRenderer {
  message?: YtText;
}
