import { describe, it, expect } from 'vitest';
import { globToRegex, matchesPattern } from '../hook-wrapper.mjs';

describe('globToRegex', () => {
  it('should convert literal characters without modification', () => {
    // Arrange
    const pattern = 'readme';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('readme');
  });

  it('should convert * wildcard to match any characters except /', () => {
    // Arrange
    const pattern = '*.json';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('[^/]*\\.json');
  });

  it('should convert ** wildcard to match any characters including /', () => {
    // Arrange
    const pattern = '.claude/**';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('\\.claude/.*');
  });

  it('should escape regex special characters', () => {
    // Arrange
    const pattern = 'file.name+extra';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('file\\.name\\+extra');
  });

  it('should convert ? wildcard to match a single character except /', () => {
    // Arrange
    const pattern = 'file?.ts';

    // Act
    const result = globToRegex(pattern);

    // Assert
    expect(result).toBe('file[^/]\\.ts');
  });
});

describe('matchesPattern', () => {
  it('should match a file path against a simple extension pattern', () => {
    // Arrange
    const filePath = 'src/config.json';
    const pattern = '*.json';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(true);
  });

  it('should return false for non-matching file path', () => {
    // Arrange
    const filePath = 'src/config.json';
    const pattern = '*.ts';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(false);
  });

  it('should support comma-separated OR patterns', () => {
    // Arrange
    const filePath = 'src/index.tsx';
    const pattern = '*.ts, *.tsx';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(true);
  });

  it('should match ** patterns across directory boundaries', () => {
    // Arrange
    const filePath = '.claude/agents/explore.md';
    const pattern = '.claude/**';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(true);
  });

  it('should match directory-scoped patterns', () => {
    // Arrange
    const filePath = '.claude/agents/test.md';
    const pattern = '.claude/agents/*.md';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(true);
  });

  it('should not match directory-scoped pattern for nested path', () => {
    // Arrange
    const filePath = '.claude/agents/sub/test.md';
    const pattern = '.claude/agents/*.md';

    // Act
    const result = matchesPattern(filePath, pattern);

    // Assert
    expect(result).toBe(false);
  });
});
