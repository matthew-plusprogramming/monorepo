import { type JSX, useState } from 'react';

import classnames from 'classnames';

import reactLogo from './assets/react.svg';

import styles from './App.module.scss';

import viteLogo from '/vite.svg';

export const App = (): JSX.Element => {
  const [count, setCount] = useState(0);

  return (
    <>
      <div>
        <a href="https://vite.dev" target="_blank" rel="noreferrer noopener">
          <img
            src={viteLogo}
            className={classnames(styles.logo)}
            alt="Vite logo"
          />
        </a>
        <a href="https://react.dev" target="_blank" rel="noreferrer noopener">
          <img
            src={reactLogo}
            className={classnames(styles.logo, styles.react)}
            alt="React logo"
          />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className={classnames(styles.card)}>
        <button onClick={() => setCount((count) => count + 1)} type="button">
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className={classnames(styles.readTheDocs)}>
        Click on the Vite and React logos to learn more
      </p>
    </>
  );
};
