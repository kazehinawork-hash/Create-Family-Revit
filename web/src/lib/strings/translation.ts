/** A translation must mirror the Vietnamese dictionary, including function shapes. */
export type Translation<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};
