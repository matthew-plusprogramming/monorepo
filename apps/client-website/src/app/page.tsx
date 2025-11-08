import type { JSX } from 'react';

import styles from './page.module.scss';

const Home = (): JSX.Element => {
  return (
    <div className={styles.heroBackground}>
      <p>Hi</p>
    </div>
  );
};

export default Home;
