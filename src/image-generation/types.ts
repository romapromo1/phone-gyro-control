export type Gender = 'male' | 'female' | 'unknown';

export interface GenerationResult {
  imageUrl: string;
  gender: Gender;
}
