import classnames from 'classnames';
import type { JSX } from 'react';

import { Navbar } from '../components/Navbar';

import styles from './page.module.scss';

const Home = (): JSX.Element => {
  return (
    <div className={classnames(styles.heroBackground, styles.heroSection)}>
      <Navbar />

      <p>Hi</p>
    </div>
  );
};

export default Home;
