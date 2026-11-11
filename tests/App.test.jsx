import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import App from '../entrypoints/popup/App.jsx';

describe('Popup App Component', () => {
  it('renders extension title and main cards', async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByText('Leeting')).toBeDefined();
    expect(screen.getByText('LeetCode & Focus Companion')).toBeDefined();
    expect(screen.getByText('Daily Challenge')).toBeDefined();
    expect(screen.getByText('Focus Mode')).toBeDefined();
    expect(screen.getByText('Solve Before Scroll')).toBeDefined();
    expect(screen.getByText('Daily LeetCoin Reward')).toBeDefined();
  });
});
