export type Styles = {
  card: string;
  logo: string;
  logoSpin: string;
  react: string;
  readTheDocs: string;
  root: string;
};

export type ClassNames = keyof Styles;

declare const styles: Styles;

export default styles;
