import classnames from 'classnames';
import type { JSX } from 'react';

import { PublicNavbar } from '@/components/Navbar';
import { HeroSectionContent } from '@/sections/Home/HeroSectionContent';

import styles from './page.module.scss';

const Home = (): JSX.Element => {
  return (
    <div className={classnames(styles.heroBackground, styles.heroSection)}>
      <PublicNavbar />

      <HeroSectionContent />
    </div>
  );
};

export default Home;
