import { Button } from '@ui/components';
import type { JSX } from 'react';

import styles from './HeroSectionContent.module.scss';

const HeroSectionContent = (): JSX.Element => {
  return (
    <div className={styles.main}>
      <p>Customizable at the Speed of Thought</p>
      <h1>Scaffolding your ideas</h1>
      <p>
        With a standard suite of tools and components to build your next big
        idea, the monorepo lets you focus on what matters most: building
        something amazing. What are you waiting for?
      </p>

      <Button
        className={styles.heroCtaButton}
        displayStyle="cta"
        clickStyle="3d"
        href="/signup"
      >
        Get started now
      </Button>
    </div>
  );
};

export { HeroSectionContent };
