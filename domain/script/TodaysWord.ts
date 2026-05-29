/**
 * 「Today's word」の値オブジェクト。
 * ESL視聴者向けの語彙ピックアップ。
 */
export interface TodaysWord {
  readonly word: string;
  readonly partOfSpeech: string; // noun / verb / adj / adv ...
  readonly definitionEn: string;
  readonly definitionJp: string;
  readonly exampleEn: string;
}
