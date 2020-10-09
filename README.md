# Jest Github Action

- Comment your pull requests with code coverage table (if tests succeeded)

## Coverage example

![Coverage](https://i.imgur.com/Ilu4gBe.png)

## How to contribute

Create a branch off from `master`

Install the modules using npm

Do your changes on `src/action.ts`

When you are done, run `npm run prepack` and then `npm run pack`

Commit your changes and push them

Create a PR on any FE project to test your changes, and remember to edit the workflow file in the FE repo(coverage.yml) so the PR will run the action based on your branch:

Instead of uses: `yieldstreet/jest-github-action@master` update it to `yieldstreet/jest-github-action@MY_BRANCH_HERE`

When you finish testing your features, feel free to open a PR to `master`

