export type Styles = {
  actions: string;
  brand: string;
  brandLink: string;
  links: string;
  logo: string;
  navbar: string;
  primaryButton: string;
  secondaryButton: string;
};

export type ClassNames = keyof Styles;

declare const styles: Styles;

export default styles;
