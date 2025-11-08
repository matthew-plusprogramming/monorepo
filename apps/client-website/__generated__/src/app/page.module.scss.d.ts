export type Styles = {
  heroBackground: string;
  heroSection: string;
};

export type ClassNames = keyof Styles;

declare const styles: Styles;

export default styles;
