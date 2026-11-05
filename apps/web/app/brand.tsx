// The logo of the app bar, for the page's theme (the other hidden by CSS), decorative: the text beside it names it. The
// approved logo (assets/brand, never redrawn), bundled with a hashed name, one per theme: the Live View's and the
// knowledge Worker's read-only page's.
import type { ReactElement } from 'react';
import logoDark from '../../../assets/brand/logo-dark.svg';
import logoLight from '../../../assets/brand/logo-light.svg';

export function BrandLogo(): ReactElement {
    return (
        <>
            <img className="brand-logo brand-logo-light" src={logoLight} alt="" />
            <img className="brand-logo brand-logo-dark" src={logoDark} alt="" />
        </>
    );
}
